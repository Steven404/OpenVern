import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_MARKER, migrateLegacyDataDir } from './migrate';
import { cleanupTempDirs, makeTempDir, recordingLogger } from './test-helpers';

cleanupTempDirs();

/** A fake home with a populated 0.1 data dir at `.config/harness`. */
async function fakeHome() {
  const home = await makeTempDir('openvern-migrate-');
  const config = path.join(home, '.config');
  const legacyDir = path.join(config, 'harness');
  await fs.mkdir(path.join(legacyDir, 'chats'), { recursive: true });
  await fs.mkdir(path.join(legacyDir, 'attachments'), { recursive: true });
  await fs.mkdir(path.join(legacyDir, 'cache'), { recursive: true });
  await fs.writeFile(path.join(legacyDir, 'settings.json'), '{"version":1,"lastModel":"x"}');
  await fs.writeFile(path.join(legacyDir, 'secrets.json'), '{"version":1}', { mode: 0o600 });
  await fs.writeFile(path.join(legacyDir, 'projects.json'), '{"version":1,"projects":[]}');
  await fs.writeFile(path.join(legacyDir, 'chats', 'index.json'), '{"version":1,"chats":[]}');
  await fs.writeFile(path.join(legacyDir, 'attachments', 'a.bin'), 'bytes');
  await fs.writeFile(path.join(legacyDir, 'cache', 'models.json'), '[]');
  return { dataDir: path.join(config, 'openvern'), legacyDir };
}

describe('migrateLegacyDataDir', () => {
  it('copies the 0.1 data, writes the marker and leaves the old dir alone', async () => {
    const { dataDir, legacyDir } = await fakeHome();
    const logger = recordingLogger();
    expect(await migrateLegacyDataDir({ dataDir, legacyDir, logger })).toBe('migrated');
    for (const f of ['settings.json', 'secrets.json', 'projects.json', 'chats/index.json', 'attachments/a.bin']) {
      expect(await fs.readFile(path.join(dataDir, f), 'utf8')).toBe(await fs.readFile(path.join(legacyDir, f), 'utf8'));
    }
    expect((await fs.stat(path.join(dataDir, 'secrets.json'))).mode & 0o777).toBe(0o600);
    await fs.access(path.join(dataDir, MIGRATION_MARKER));
    await fs.access(path.join(legacyDir, 'settings.json'));
    await expect(fs.access(path.join(legacyDir, MIGRATION_MARKER))).rejects.toThrow();
    expect(logger.messages).toHaveLength(1);
  });

  it('runs once: a second call does nothing, even if the old dir changes', async () => {
    const { dataDir, legacyDir } = await fakeHome();
    await migrateLegacyDataDir({ dataDir, legacyDir });
    await fs.writeFile(path.join(legacyDir, 'settings.json'), '{"version":1,"lastModel":"changed"}');
    expect(await migrateLegacyDataDir({ dataDir, legacyDir })).toBe('skipped');
    expect(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).toContain('"x"');
  });

  it('skips when the new dir already has data (settings, projects or chats)', async () => {
    for (const [file, body] of [
      ['settings.json', '{}'],
      ['projects.json', '{}'],
      ['chats/index.json', '{}'],
    ] as const) {
      const { dataDir, legacyDir } = await fakeHome();
      await fs.mkdir(path.dirname(path.join(dataDir, file)), { recursive: true });
      await fs.writeFile(path.join(dataDir, file), body);
      expect(await migrateLegacyDataDir({ dataDir, legacyDir })).toBe('skipped');
      await expect(fs.access(path.join(dataDir, MIGRATION_MARKER))).rejects.toThrow();
    }
  });

  it('treats an empty chats/ dir (made by ensureDataDir) as no data', async () => {
    const { dataDir, legacyDir } = await fakeHome();
    await fs.mkdir(path.join(dataDir, 'chats'), { recursive: true });
    expect(await migrateLegacyDataDir({ dataDir, legacyDir })).toBe('migrated');
  });

  it('skips when there is no 0.1 data', async () => {
    const home = await makeTempDir('openvern-migrate-');
    const dataDir = path.join(home, '.config', 'openvern');
    expect(await migrateLegacyDataDir({ dataDir, legacyDir: path.join(home, '.config', 'harness') })).toBe('skipped');
    await expect(fs.access(dataDir)).rejects.toThrow();
  });
});
