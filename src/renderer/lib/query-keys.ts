// TanStack Query keys (shared seam between S6 and S7). Always use these so invalidation lines up.
//   settings → PublicSettings · models → ModelInfo[] · projects → ProjectListItem[]
//   chats → ChatSummary[] · chat(id) → Chat
//   projectFolder(projectId, dir) → ProjectFileListing · projectFileSearch(projectId, q) → ProjectFileSearchResult
//   (both under the `projectFiles(projectId)` prefix, so one invalidation refreshes open folders and the filter)
//   projectFile(projectId, path) → ProjectFileContent
//   homeFolder(dir) → HomeFileListing · homeFileSearch(q) → ProjectFileSearchResult (under the `homeFiles` prefix)
//   chatChanges(chatId) → ChatChanges (under the `allChatChanges` prefix)

import type { Id } from '@shared/types';

export const queryKeys = {
  settings: ['settings'] as const,
  models: ['models'] as const,
  projects: ['projects'] as const,
  chats: ['chats'] as const,
  /**
   * Read only through `chatQueryOptions` (`stores/edit-modes.ts`): its queryFn feeds the chip's shown edit mode. Another
   * queryFn on this key, or a `setQueryData` of a chat the server just returned without `noteAnswer`, would not.
   */
  chat: (id: Id) => ['chat', id] as const,
  /** Prefix of every Files-panel listing and search of a project (invalidation only). */
  projectFiles: (projectId: Id) => ['projectFiles', projectId] as const,
  projectFolder: (projectId: Id, dir: string) => ['projectFiles', projectId, dir] as const,
  // An object, so it can never equal a folder path.
  projectFileSearch: (projectId: Id, query: string) => ['projectFiles', projectId, { search: query }] as const,
  projectFile: (projectId: Id, path: string) => ['projectFile', projectId, path] as const,
  /** Prefix of every Files-panel listing and search of the home folder (invalidation only). */
  homeFiles: ['homeFiles'] as const,
  homeFolder: (dir: string) => ['homeFiles', dir] as const,
  homeFileSearch: (query: string) => ['homeFiles', { search: query }] as const,
  homeFile: (path: string) => ['homeFile', path] as const,
  /** Prefix of every chat's changes (invalidation only). */
  allChatChanges: ['chatChanges'] as const,
  chatChanges: (chatId: Id) => ['chatChanges', chatId] as const,
};
