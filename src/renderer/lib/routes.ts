// Hash routes (shared seam between S6 and S7).
//   #/new                → New chat screen (S7 `NewChatScreen`)
//   #/new?project=<id>   → same, with that project preselected in the project chip
//   #/chat/:id           → Chat screen (S6 `ChatHeader` + S7 `Conversation` + S7 `ReplyComposer`)

import type { Id } from '@shared/types';

export const NEW_CHAT_PROJECT_PARAM = 'project';

export const paths = {
  newChat: (projectId?: Id | null) =>
    projectId ? `/new?${NEW_CHAT_PROJECT_PARAM}=${encodeURIComponent(projectId)}` : '/new',
  chat: (id: Id) => `/chat/${id}`,
};
