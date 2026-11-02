// Composition root (plan §4.8, S5.6): wires storage, provider, model catalog and the agent into a `Core`.

import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APP_SLUG } from '@shared/constants';
import { createAgentService } from './agent';
import { createChangesService } from './changes';
import { createProjectFilesService } from './project-files';
import { createModelCatalog } from './providers/models';
import { createOpenRouterProvider } from './providers/openrouter';
import { createStorage, dataPaths, expandHome, LEGACY_SLUG } from './storage';
import { getProjectTools, renderTree } from './tools';
import type { Core, CoreDeps } from './types';

/**
 * Default production data dir(s), denied to the tools whichever instance is running: `$XDG_CONFIG_HOME/openvern`, else
 * `~/.config/openvern`, plus the legacy 0.1 dir `…/harness` (it still holds the old chats and key). Realpath when it exists, the lexical path otherwise.
 */
export async function defaultDataDirRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<string[]> {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = path.resolve(xdg ? xdg : path.join(home, '.config'));
  return Promise.all(
    [APP_SLUG, LEGACY_SLUG].map((slug) => {
      const dir = path.join(base, slug);
      return realpath(dir).catch(() => dir);
    }),
  );
}

export async function createCore(deps: CoreDeps): Promise<Core> {
  const storage = await createStorage({ dataDir: deps.dataDir, secretStore: deps.secretStore });
  const { settings, projects, chats, attachments } = storage;

  const provider = deps.provider ?? createOpenRouterProvider({ getApiKey: () => settings.getApiKey() });
  // `createStorage` made the data dir absolute (and expanded `~`) and created it; mirror that here. The realpath is
  // what the tool sandbox compares against, so a project folder containing the data dir cannot reach it (S1-M1).
  const dataReal = await realpath(path.resolve(expandHome(deps.dataDir)));
  const deniedRoots = [...new Set([dataReal, ...(await defaultDataDirRoots())])];
  // A hardlink of a key file under an allowed name is blocked by inode (plan K1).
  const deniedFiles = deniedRoots.map((r) => dataPaths(r).secrets);
  const cacheFile = dataPaths(dataReal).modelsCache;
  const models = createModelCatalog({ provider, cacheFile });
  const changes = createChangesService({ dataDir: dataReal, sandbox: { deniedRoots, deniedFiles } });
  const agent = createAgentService({
    version: deps.version,
    changes,
    chats,
    attachments,
    projects,
    models,
    provider,
    getProjectTools: () => getProjectTools({ deniedRoots, deniedFiles }),
    getKnownSecrets: async () => {
      const key = await settings.getApiKey();
      return key ? [key] : [];
    },
    renderTree: (root, opts) => renderTree(root, { ...opts, deniedRoots }),
  });

  await attachments.cleanupOrphans();

  return {
    settings,
    projects,
    chats,
    attachments,
    models,
    agent,
    provider,
    changes,
    projectFiles: createProjectFilesService({ projects, deniedRoots, deniedFiles }),
    version: deps.version,
  };
}

export type * from './types';
