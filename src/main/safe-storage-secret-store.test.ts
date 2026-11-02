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
