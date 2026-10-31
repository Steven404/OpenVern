// Composition root (plan §4.8, S5.6): wires storage, provider, model catalog and the agent into a `Core`.

import path from 'node:path';
import { createAgentService } from './agent';
import { createModelCatalog } from './providers/models';
import { createOpenRouterProvider } from './providers/openrouter';
import { createStorage, dataPaths, expandHome } from './storage';
import { getProjectTools, renderTree } from './tools';
import type { Core, CoreDeps } from './types';

export async function createCore(deps: CoreDeps): Promise<Core> {
  const storage = await createStorage({ dataDir: deps.dataDir, secretStore: deps.secretStore });
  const { settings, projects, chats, attachments } = storage;

  const provider = deps.provider ?? createOpenRouterProvider({ getApiKey: () => settings.getApiKey() });
  // `createStorage` made the data dir absolute (and expanded `~`); mirror that for the cache path.
  const cacheFile = dataPaths(path.resolve(expandHome(deps.dataDir))).modelsCache;
  const models = createModelCatalog({ provider, cacheFile });
  const agent = createAgentService({
    chats,
    attachments,
    projects,
    models,
    provider,
    getProjectTools,
    renderTree,
  });

  await attachments.cleanupOrphans();

  return { settings, projects, chats, attachments, models, agent, provider };
}

export type * from './types';
