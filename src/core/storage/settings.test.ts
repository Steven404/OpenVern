import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoreError } from '../errors';
import { dataPaths } from './paths';
import { FileSecretStore } from './secrets';
import { createSettingsService, keyHint } from './settings';
import { cleanupTempDirs, makeStorage, makeTempDir, recordingLogger } from './test-helpers';

cleanupTempDirs();

const KEY = 'sk-or-v1-abcdef0123456789abcdef0123456789a1b2';

describe('keyHint', () => {
  it('is first 9 chars + … + last 4', () => {
    expect(keyHint(KEY)).toBe('sk-or-v1-…a1b2');
  });
  it('does not leak short keys', () => {
    expect(keyHint('short')).toBe('…');
    expect(keyHint('abcdefghij')).toBe('…ghij');
  });
});

describe('FileSecretStore', () => {
  it('writes secrets.json with mode 0600 in the documented format', async () => {
    const dir = await makeTempDir();
    const file = dataPaths(dir).secrets;
    const store = new FileSecretStore(file);
    await store.set('openrouter', 'abc');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      version: 1,
      openrouter: { enc: 'plain', value: 'abc' },
    });
    // Still 0600 after further rewrites.
    await store.set('other', 'x');
    await store.set('openrouter', 'def');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.get('openrouter')).toBe('def');
    expect(await store.get('other')).toBe('x');
  });

  it('get returns null for unknown names / missing file; delete is idempotent', async () => {
    const store = new FileSecretStore(path.join(await makeTempDir(), 'secrets.json'));
    expect(await store.get('openrouter')).toBeNull();
    await store.delete('openrouter');
    await store.set('openrouter', 'abc');
    await store.delete('openrouter');
    expect(await store.get('openrouter')).toBeNull();
  });

  it('survives concurrent sets of different names', async () => {
    const store = new FileSecretStore(path.join(await makeTempDir(), 'secrets.json'));
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set(`k${i}`, `v${i}`)));
    for (let i = 0; i < 20; i++) expect(await store.get(`k${i}`)).toBe(`v${i}`);
  });

  it('cannot read safeStorage-encrypted entries, and rejects the reserved name', async () => {
    const file = path.join(await makeTempDir(), 'secrets.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, openrouter: { enc: 'safeStorage', value: 'zzz' } }));
    const store = new FileSecretStore(file, { logger: recordingLogger() });
    expect(await store.get('openrouter')).toBeNull();
    await expect(store.set('version', 'x')).rejects.toBeInstanceOf(CoreError);
  });

  it('backs up a corrupt secrets file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'secrets.json');
    await fs.writeFile(file, 'garbage');
    const store = new FileSecretStore(file, { logger: recordingLogger() });
    expect(await store.get('openrouter')).toBeNull();
    expect((await fs.readdir(dir)).some((n) => n.startsWith('secrets.json.corrupt-'))).toBe(true);
  });
});

describe('SettingsService', () => {
  it('starts unconfigured with no last model', async () => {
    const { storage } = await makeStorage();
    expect(await storage.settings.get()).toEqual({
      openRouter: { configured: false, keyHint: null },
      lastModel: null,
      lastEffort: null,
    });
    expect(await storage.settings.getApiKey()).toBeNull();
  });

  it('stores, masks and clears the key; never exposes it in PublicSettings', async () => {
    const { storage, secrets } = await makeStorage();
    const after = await storage.settings.setApiKey(`  ${KEY}  `);
    expect(after).toEqual({
      openRouter: { configured: true, keyHint: 'sk-or-v1-…a1b2' },
      lastModel: null,
      lastEffort: null,
    });
    expect(JSON.stringify(after)).not.toContain(KEY);
    expect(await storage.settings.getApiKey()).toBe(KEY);
    expect(secrets.data.get('openrouter')).toBe(KEY);
    const cleared = await storage.settings.clearApiKey();
    expect(cleared.openRouter).toEqual({ configured: false, keyHint: null });
    expect(await storage.settings.getApiKey()).toBeNull();
  });

  it('rejects an empty key', async () => {
    const { storage } = await makeStorage();
    await expect(storage.settings.setApiKey('   ')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('persists lastModel across instances; empty patch changes nothing', async () => {
    const { storage, dataDir, secrets } = await makeStorage();
    expect((await storage.settings.update({ lastModel: 'a/b' })).lastModel).toBe('a/b');
    expect((await storage.settings.update({})).lastModel).toBe('a/b');
    const again = createSettingsService({ filePath: dataPaths(dataDir).settings, secretStore: secrets });
    expect((await again.get()).lastModel).toBe('a/b');
    expect(JSON.parse(await fs.readFile(dataPaths(dataDir).settings, 'utf8'))).toEqual({
      version: 1,
      lastModel: 'a/b',
      lastEffort: null,
    });
  });

  it('lastEffort defaults to null, round-trips across instances, and null clears it (F3)', async () => {
    const { storage, dataDir, secrets } = await makeStorage();
    expect((await storage.settings.get()).lastEffort).toBeNull();
    expect((await storage.settings.update({ lastEffort: 'high' })).lastEffort).toBe('high');
    const again = createSettingsService({ filePath: dataPaths(dataDir).settings, secretStore: secrets });
    expect((await again.get()).lastEffort).toBe('high');
    expect((await again.update({ lastEffort: null })).lastEffort).toBeNull();
    expect((await again.get()).lastEffort).toBeNull();
  });

  it('a lastModel patch keeps lastEffort, and a lastEffort patch keeps lastModel (F3)', async () => {
    const { storage } = await makeStorage();
    await storage.settings.update({ lastModel: 'a/b', lastEffort: 'medium' });
    expect(await storage.settings.update({ lastModel: 'c/d' })).toMatchObject({
      lastModel: 'c/d',
      lastEffort: 'medium',
    });
    expect(await storage.settings.update({ lastEffort: 'max' })).toMatchObject({ lastModel: 'c/d', lastEffort: 'max' });
  });

  it('a settings file from before F3 (no lastEffort) reads as null, keeping lastModel (F3)', async () => {
    const { dataDir, secrets } = await makeStorage();
    await fs.writeFile(dataPaths(dataDir).settings, JSON.stringify({ version: 1, lastModel: 'a/b' }));
    const old = createSettingsService({ filePath: dataPaths(dataDir).settings, secretStore: secrets });
    expect(await old.get()).toMatchObject({ lastModel: 'a/b', lastEffort: null });
  });

  it('works end to end with a FileSecretStore', async () => {
    const dir = await makeTempDir();
    const paths = dataPaths(dir);
    const settings = createSettingsService({
      filePath: paths.settings,
      secretStore: new FileSecretStore(paths.secrets),
    });
    await settings.setApiKey(KEY);
    expect((await settings.get()).openRouter.configured).toBe(true);
    expect((await fs.stat(paths.secrets)).mode & 0o777).toBe(0o600);
  });
});
