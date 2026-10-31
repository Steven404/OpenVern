// Core composition contracts (plan §4.8). `createCore` itself is implemented in S5 (`./index.ts`).
// Service method signatures are added by their owning sections (S1, S2, S4) in their first PR.

import type { Provider } from './providers/types';

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface CoreDeps {
  dataDir: string;
  secretStore: SecretStore;
  provider?: Provider; // default: OpenRouter
  mode: 'dev' | 'prod';
}

// Placeholders until S1/S2/S4 define them.
// biome-ignore lint/suspicious/noEmptyInterface: filled in by S1
export interface SettingsService {}
// biome-ignore lint/suspicious/noEmptyInterface: filled in by S1
export interface ProjectsService {}
// biome-ignore lint/suspicious/noEmptyInterface: filled in by S1
export interface ChatsService {}
// biome-ignore lint/suspicious/noEmptyInterface: filled in by S1
export interface AttachmentsService {}
// biome-ignore lint/suspicious/noEmptyInterface: filled in by S2
export interface ModelCatalog {}
// biome-ignore lint/suspicious/noEmptyInterface: filled in by S4
export interface AgentService {}

export interface Core {
  settings: SettingsService; // S1
  projects: ProjectsService; // S1
  chats: ChatsService; // S1
  attachments: AttachmentsService; // S1
  models: ModelCatalog; // S2
  agent: AgentService; // S4
}

export type CreateCore = (deps: CoreDeps) => Promise<Core>;
