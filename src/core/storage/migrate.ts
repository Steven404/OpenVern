// One-time copy of the 0.1 ("harness") data dir into the OpenVern one (v0.2 plan G0.4).
// The old dir is never modified: 0.1 still runs from it.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StorageLogger } from './json-file';

/** Name of the 0.1 data dir / Electron profile (a sibling of the new one under the config home). */
export const LEGACY_SLUG = 'harness';
/** Written into the new data dir once the copy is done. */
export const MIGRATION_MARKER = 'migrated-from-harness';

const COPIED = ['settings.json', 'secrets.json', 'projects.json', 'chats', 'attachments', 'cache'] as const;

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

async function hasData(dir: string): Promise<boolean> {
  if ((await exists(path.join(dir, 'settings.json'))) || (await exists(path.join(dir, 'projects.json')))) return true;
  const chats = await fs.readdir(path.join(dir, 'chats')).catch(() => [] as string[]);
  return chats.length > 0;
}

export type MigrationResult = 'migrated' | 'skipped';

/**
 * Copies `settings.json`, `secrets.json`, `projects.json`, `chats/`, `attachments/` and `cache/` from `legacyDir` into
 * `dataDir`, then writes the marker. Does nothing when `dataDir` already has data or the marker, or when `legacyDir`
 * has none. A secret that no longer decrypts is handled by the secret store (it reads as "no key").
 */
export async function migrateLegacyDataDir(opts: {
  dataDir: string;
  legacyDir: string;
  logger?: StorageLogger;
}): Promise<MigrationResult> {
  const { dataDir, legacyDir } = opts;
  const logger = opts.logger ?? { warn: (m) => console.warn(`[openvern:migrate] ${m}`) };
  if (path.resolve(dataDir) === path.resolve(legacyDir)) return 'skipped';
  if (await exists(path.join(dataDir, MIGRATION_MARKER))) return 'skipped';
  if (await hasData(dataDir)) return 'skipped';
  if (!(await hasData(legacyDir))) return 'skipped';

  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  for (const name of COPIED) {
    const from = path.join(legacyDir, name);
    if (!(await exists(from))) continue;
    await fs.cp(from, path.join(dataDir, name), { recursive: true, force: false, errorOnExist: false });
  }
  await fs.chmod(path.join(dataDir, 'secrets.json'), 0o600).catch(() => undefined);
  await fs.writeFile(path.join(dataDir, MIGRATION_MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 });
  logger.warn(`Copied your 0.1 data from ${legacyDir} to ${dataDir}. The old folder was left untouched.`);
  return 'migrated';
}
