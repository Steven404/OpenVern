// TanStack Query keys (shared seam between S6 and S7). Always use these so invalidation lines up.
//   settings → PublicSettings · models → ModelInfo[] · projects → ProjectListItem[]
//   chats → ChatSummary[] · chat(id) → Chat

import type { Id } from '@shared/types';

export const queryKeys = {
  settings: ['settings'] as const,
  models: ['models'] as const,
  projects: ['projects'] as const,
  chats: ['chats'] as const,
  chat: (id: Id) => ['chat', id] as const,
};
