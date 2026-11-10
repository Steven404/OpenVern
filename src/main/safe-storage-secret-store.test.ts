import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecretStore, type SafeStorageLike, SafeStorageSecretStore } from './safe-storage-secret-store';

/** Reversible fake "encryption" (reverses + prefixes the bytes) so plaintext never appears in the file. */
function fakeSafeStorage(over: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC:${[...s].reverse().join('')}`),
    decryptString: (b) => {
      const text = b.toString();
      if (!text.startsWith('ENC:')) throw new Error('bad ciphertext');
      return [...text.slice(4)].reverse().join('');
    },
    getSelectedStorageBackend: () => 'kwallet6',
    ...over,
  };
}

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'openvern-secrets-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const quiet = { info: vi.fn(), warn: vi.fn() };

describe('SafeStorageSecretStore', () => {
  it('round-trips, stores ciphertext (no plaintext) with mode 0600, and deletes', async () => {
    const file = path.join(await tmp(), 'secrets.json');
    const store = new SafeStorageSecretStore(file, fakeSafeStorage());
    expect(await store.get('openrouter')).toBeNull();
    await store.set('openrouter', 'sk-or-v1-supersecret');
    expect(await store.get('openrouter')).toBe('sk-or-v1-supersecret');

    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain('supersecret');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.openrouter.enc).toBe('safeStorage');
    expect(Buffer.from(parsed.openrouter.value, 'base64').toString()).toMatch(/^ENC:/);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    await store.delete('openrouter');
    expect(await store.get('openrouter')).toBeNull();
  });

  it('reads a plain entry (saved by the fallback) and re-encrypts it in place (S8-N1)', async () => {
    const file = path.join(await tmp(), 'secrets.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, openrouter: { enc: 'plain', value: 'old-plain-key' } }));
    const warn = vi.fn();
    const store = new SafeStorageSecretStore(file, fakeSafeStorage(), { logger: { warn } });
    expect(await store.get('openrouter')).toBe('old-plain-key');

    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain('old-plain-key');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.openrouter.enc).toBe('safeStorage');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    // Logged by name only, never the value.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"openrouter"'));
    for (const [m] of warn.mock.calls) expect(String(m)).not.toContain('old-plain-key');

    // Round-trips through a fresh store reading the now-encrypted entry.
    expect(await new SafeStorageSecretStore(file, fakeSafeStorage()).get('openrouter')).toBe('old-plain-key');
    await store.set('openrouter', 'new-key');
    expect(await store.get('openrouter')).toBe('new-key');
  });

  it('keeps a plain entry (and still returns it) when re-encryption fails', async () => {
    const file = path.join(await tmp(), 'secrets.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, openrouter: { enc: 'plain', value: 'old-plain-key' } }));
    const warn = vi.fn();
    const safe = fakeSafeStorage({
      encryptString: () => {
        throw new Error('keyring locked');
      },
    });
    const store = new SafeStorageSecretStore(file, safe, { logger: { warn } });
    expect(await store.get('openrouter')).toBe('old-plain-key');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).openrouter).toEqual({ enc: 'plain', value: 'old-plain-key' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"openrouter"'));
    for (const [m] of warn.mock.calls) expect(String(m)).not.toContain('old-plain-key');
    expect(await store.get('openrouter')).toBe('old-plain-key');
  });

  it('returns null (and warns) when decryption fails', async () => {
    const file = path.join(await tmp(), 'secrets.json');
    const warn = vi.fn();
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        openrouter: { enc: 'safeStorage', value: Buffer.from('garbage').toString('base64') },
      }),
    );
    const store = new SafeStorageSecretStore(file, fakeSafeStorage(), { logger: { warn } });
    expect(await store.get('openrouter')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('rejects invalid names', async () => {
    const store = new SafeStorageSecretStore(path.join(await tmp(), 's.json'), fakeSafeStorage());
    await expect(store.set('version', 'x')).rejects.toThrow();
    await expect(store.get('')).rejects.toThrow();
  });
});

describe('createSecretStore', () => {
  it('uses safeStorage when available', async () => {
    const dir = await tmp();
    const store = createSecretStore(dir, fakeSafeStorage(), quiet);
    expect(store).toBeInstanceOf(SafeStorageSecretStore);
  });

  it('falls back to the plaintext file store when encryption is unavailable or weak', async () => {
    for (const safe of [
      fakeSafeStorage({ isEncryptionAvailable: () => false }),
      fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }),
    ]) {
      const dir = await tmp();
      quiet.warn.mockClear();
      const store = createSecretStore(dir, safe, quiet);
      expect(store).not.toBeInstanceOf(SafeStorageSecretStore);
      expect(quiet.warn).toHaveBeenCalled();
      await store.set('openrouter', 'k');
      expect(JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')).openrouter).toEqual({
        enc: 'plain',
        value: 'k',
      });
    }
  });
});

describe('AS-07 platform and failure contracts', () => {
  it('selects Keychain without the optional backend and falls back only at startup', async () => {
    const safe = fakeSafeStorage();
    delete safe.getSelectedStorageBackend;
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(createSecretStore(await tmp(), safe, logger, { platform: 'darwin' })).toBeInstanceOf(SafeStorageSecretStore);
    expect(logger.info).toHaveBeenCalledWith('secrets encrypted with safeStorage (macOS Keychain).');
    const dir = await tmp();
    const fallback = createSecretStore(dir, { ...safe, isEncryptionAvailable: () => false }, logger, {
      platform: 'darwin',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'safeStorage is unavailable (the macOS Keychain is not available); falling back to a plaintext secrets.json (mode 0600).',
    );
    await fallback.set('dummy', 'dummy-value');
    const file = path.join(dir, 'secrets.json');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).dummy).toEqual({ enc: 'plain', value: 'dummy-value' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it.each(['kwallet6', 'basic_text', 'unknown', undefined])(
    'preserves Linux backend selection for %s',
    async (backend) => {
      const safe = fakeSafeStorage();
      if (backend === undefined) delete safe.getSelectedStorageBackend;
      else safe.getSelectedStorageBackend = () => backend;
      const logger = { info: vi.fn(), warn: vi.fn() };
      const store = createSecretStore(await tmp(), safe, logger, { platform: 'linux' });
      if (backend === 'basic_text' || backend === 'unknown') {
        expect(store).not.toBeInstanceOf(SafeStorageSecretStore);
        expect(logger.warn).toHaveBeenCalledWith(
          `safeStorage is unavailable (backend: ${backend}); falling back to a plaintext secrets.json (mode 0600).`,
        );
      } else {
        expect(store).toBeInstanceOf(SafeStorageSecretStore);
        expect(logger.info).toHaveBeenCalledWith(`secrets encrypted with safeStorage (backend: ${backend ?? 'n/a'}).`);
      }
    },
  );

  it.each(['darwin', 'linux', 'win32'] as const)('does not write on encryption failure on %s', async (platform) => {
    const file = path.join(await tmp(), 'secrets.json');
    const original = '{"version":1,"other":{"enc":"plain","value":"other-dummy"}}';
    await fs.writeFile(file, original);
    const warn = vi.fn();
    const broken = fakeSafeStorage({
      encryptString: () => {
        throw new Error('native-dummy-message ciphertext-dummy plaintext-dummy');
      },
    });
    const store = new SafeStorageSecretStore(file, broken, { platform, logger: { warn } });
    let caught: unknown;
    try {
      await store.set('dummy', 'plaintext-dummy');
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'internal' });
    expect(String(caught)).toContain(
      platform === 'darwin' ? 'Keychain' : platform === 'linux' ? 'keyring' : 'credential store',
    );
    const exposed = `${String(caught)} ${(caught as Error).stack} ${JSON.stringify(caught)} ${JSON.stringify(warn.mock.calls)} ${(caught as Error).cause}`;
    for (const value of ['native-dummy-message', 'ciphertext-dummy', 'plaintext-dummy'])
      expect(exposed).not.toContain(value);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    const missing = path.join(await tmp(), 'secrets.json');
    await expect(
      new SafeStorageSecretStore(missing, broken, { platform, logger: { warn } }).set('dummy', 'plaintext-dummy'),
    ).rejects.toThrow();
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await new SafeStorageSecretStore(file, fakeSafeStorage()).set('dummy', 'plaintext-dummy');
    expect(await fs.readFile(file, 'utf8')).not.toContain('plaintext-dummy');
    expect(await new SafeStorageSecretStore(file, fakeSafeStorage()).get('dummy')).toBe('plaintext-dummy');
  });

  it('retains ciphertext after decrypt failure and recovers later', async () => {
    const file = path.join(await tmp(), 'secrets.json');
    await new SafeStorageSecretStore(file, fakeSafeStorage()).set('dummy', 'dummy-value');
    const before = await fs.readFile(file, 'utf8');
    const warn = vi.fn();
    const broken = fakeSafeStorage({
      decryptString: () => {
        throw new Error('native-dummy-message');
      },
    });
    expect(await new SafeStorageSecretStore(file, broken, { logger: { warn } }).get('dummy')).toBeNull();
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(warn).toHaveBeenCalledWith('Could not decrypt secret "dummy"; treating it as not set (Error).');
    expect(await new SafeStorageSecretStore(file, fakeSafeStorage()).get('dummy')).toBe('dummy-value');
  });

  it('retains plain bytes and returns the value when migration fails', async () => {
    const file = path.join(await tmp(), 'secrets.json');
    const before = '{ "version": 1, "dummy": { "enc": "plain", "value": "dummy-value" } }';
    await fs.writeFile(file, before);
    const warn = vi.fn();
    const safe = fakeSafeStorage({
      encryptString: () => {
        throw new Error('native-dummy-message');
      },
    });
    expect(await new SafeStorageSecretStore(file, safe, { logger: { warn } }).get('dummy')).toBe('dummy-value');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('native-dummy-message');
  });

  it.each([
    ['Error', 'EACCES', 'Error EACCES'],
    ['malicious-dummy-name', 'bad-dummy-code', 'Error'],
    ['Error', 'EPRIVATE_TEST_VALUE', 'Error'],
  ])('sanitizes error metadata %s %s', async (name, code, label) => {
    const warn = vi.fn();
    const err = Object.assign(new Error('native-dummy-message'), { name, code });
    const safe = fakeSafeStorage({
      encryptString: () => {
        throw err;
      },
    });
    await expect(
      new SafeStorageSecretStore(path.join(await tmp(), 'secrets.json'), safe, { logger: { warn } }).set(
        'dummy',
        'dummy-value',
      ),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(`Could not encrypt secret "dummy"; it was not saved (${label}).`);
  });

  it('defaults to the actual platform', async () => {
    const safe = fakeSafeStorage();
    delete safe.getSelectedStorageBackend;
    const implicit = { info: vi.fn(), warn: vi.fn() };
    const explicit = { info: vi.fn(), warn: vi.fn() };
    createSecretStore(await tmp(), safe, implicit);
    createSecretStore(await tmp(), safe, explicit, { platform: process.platform });
    expect(implicit.info.mock.calls).toEqual(explicit.info.mock.calls);
  });
});
