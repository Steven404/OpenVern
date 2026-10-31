// Data directory resolution and layout (plan §3.5).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Environment variable that overrides the data dir in every mode (plan §3.2). */
export const DATA_DIR_ENV = 'HARNESS_DATA_DIR';

export interface DataPaths {
  root: string;
  settings: string;
  secrets: string;
  projects: string;
  chatsDir: string;
  chatsIndex: string;
  attachmentsDir: string;
  cacheDir: string;
  modelsCache: string;
  chatFile(id: string): string;
  attachmentBin(id: string): string;
  attachmentMeta(id: string): string;
}

/** Expands a leading `~` (alone or followed by a separator) to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith(`~${path.sep}`)) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Lays out every well-known path under an (already absolute) data dir. Does not touch the disk. */
export function dataPaths(root: string): DataPaths {
  const chatsDir = path.join(root, 'chats');
  const attachmentsDir = path.join(root, 'attachments');
  const cacheDir = path.join(root, 'cache');
  return {
    root,
    settings: path.join(root, 'settings.json'),
    secrets: path.join(root, 'secrets.json'),
    projects: path.join(root, 'projects.json'),
    chatsDir,
    chatsIndex: path.join(chatsDir, 'index.json'),
    attachmentsDir,
    cacheDir,
    modelsCache: path.join(cacheDir, 'models.json'),
    chatFile: (id) => path.join(chatsDir, `${id}.json`),
    attachmentBin: (id) => path.join(attachmentsDir, `${id}.bin`),
    attachmentMeta: (id) => path.join(attachmentsDir, `${id}.json`),
  };
}

/** Creates the directory tree of plan §3.5 (idempotent). The data dir itself is made owner-only. */
export async function ensureDataDir(root: string): Promise<DataPaths> {
  const abs = path.resolve(expandHome(root));
  const paths = dataPaths(abs);
  await fs.mkdir(abs, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.mkdir(paths.chatsDir, { recursive: true }),
    fs.mkdir(paths.attachmentsDir, { recursive: true }),
    fs.mkdir(paths.cacheDir, { recursive: true }),
  ]);
  return paths;
}

/**
 * Picks the data dir (`HARNESS_DATA_DIR` wins, then `dataDir`; one of them is required), expands `~`,
 * makes it absolute and creates the tree of plan §3.5. Returns the absolute path.
 */
export async function resolveDataDir(dataDir?: string): Promise<string> {
  const chosen = process.env[DATA_DIR_ENV]?.trim() || dataDir?.trim();
  if (!chosen) throw new Error(`No data directory: pass one or set ${DATA_DIR_ENV}.`);
  return (await ensureDataDir(chosen)).root;
}
