// TanStack Query keys (shared seam between S6 and S7). Always use these so invalidation lines up.
//   settings → PublicSettings · models → ModelInfo[] · projects → ProjectListItem[]
//   chats → ChatSummary[] · chat(id) → Chat
//   projectFiles(projectId) → ProjectFileTree · projectFile(projectId, path) → ProjectFileContent
//   chatChanges(chatId) → ChatChanges

import type { Id } from '@shared/types';

export const queryKeys = {
  settings: ['settings'] as const,
  models: ['models'] as const,
  projects: ['projects'] as const,
  chats: ['chats'] as const,
  chat: (id: Id) => ['chat', id] as const,
  projectFiles: (projectId: Id) => ['projectFiles', projectId] as const,
  projectFile: (projectId: Id, path: string) => ['projectFile', projectId, path] as const,
  chatChanges: (chatId: Id) => ['chatChanges', chatId] as const,
};
