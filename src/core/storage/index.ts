// Storage layer (S1): JSON files in a data dir, atomic writes, no native modules, no Electron (plan §3.5).
//
//   const storage = await createStorage({ dataDir, secretStore: createFileSecretStore(dataDir) });
//   storage.settings / .projects / .chats / .attachments
//
// `dataDir` is used as given (made absolute, `~` expanded). Use `resolveDataDir()` first if `HARNESS_DATA_DIR`
// should override it. Callers should run `storage.attachments.cleanupOrphans()` once at startup.

import path from 'node:path';
import type { Id } from '@shared/types';
import { CoreError } from '../errors';
import type { AttachmentsService, ChatsService, ProjectsService, SecretStore, SettingsService } from '../types';
import { createAttachmentsService } from './attachments';
import { createChatsService } from './chats';
import type { StorageLogger } from './json-file';
import { dataPaths, ensureDataDir, expandHome } from './paths';
import { createProjectsService } from './projects';
import { FileSecretStore } from './secrets';
import { createSettingsService } from './settings';

export interface StorageOptions {
  dataDir: string;
  secretStore: SecretStore;
  /** Where corrupt-file warnings go. Default: `console.warn`. */
  logger?: StorageLogger;
}

export interface Storage {
  settings: SettingsService;
  projects: ProjectsService;
  chats: ChatsService;
  attachments: AttachmentsService;
}

/** Creates the data dir tree (idempotent) and wires the four services together. */
export async function createStorage(opts: StorageOptions): Promise<Storage> {
  const paths = await ensureDataDir(opts.dataDir);
  const { logger } = opts;

  // chats ↔ projects are mutually dependent: chats validate project ids, projects count / re-home chats.
  let projects: ProjectsService | undefined;
  const chats = createChatsService({
    dataDir: paths.root,
    logger,
    projectExists: async (id: Id) => {
      try {
        await projects?.get(id);
        return true;
      } catch (err) {
        if (err instanceof CoreError && err.code === 'not_found') return false;
        throw err;
      }
    },
  });
  projects = createProjectsService({ filePath: paths.projects, chats, logger });

  return {
    settings: createSettingsService({ filePath: paths.settings, secretStore: opts.secretStore, logger }),
    projects,
    chats,
    attachments: createAttachmentsService({ dataDir: paths.root, logger }),
  };
}

/** Dev / fallback secret store: plaintext `secrets.json` (mode 0600) in the data dir. */
export function createFileSecretStore(dataDir: string, opts: { logger?: StorageLogger } = {}): FileSecretStore {
  return new FileSecretStore(dataPaths(path.resolve(expandHome(dataDir))).secrets, opts);
}

export { type AttachmentsServiceOptions, createAttachmentsService, sniffAttachment } from './attachments';
export { type ChatsServiceOptions, createChatsService } from './chats';
export { JsonFile, type StorageLogger, writeFileAtomic } from './json-file';
export { DATA_DIR_ENV, type DataPaths, dataPaths, ensureDataDir, expandHome, resolveDataDir } from './paths';
export { createProjectsService, type ProjectsServiceOptions } from './projects';
export { FileSecretStore } from './secrets';
export { createSettingsService, keyHint, OPENROUTER_SECRET, type SettingsServiceOptions } from './settings';
