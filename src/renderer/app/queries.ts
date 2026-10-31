// Shared server-data hooks for the S6 features (sidebar, header, modals). Keys come from `lib/query-keys.ts`.

import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { paths } from '@renderer/lib/routes';
import { useQuery } from '@tanstack/react-query';
import { useMatch } from 'react-router';

export function useProjects() {
  const api = useApiClient();
  return useQuery({ queryKey: queryKeys.projects, queryFn: () => api.listProjects() });
}

export function useChats() {
  const api = useApiClient();
  return useQuery({ queryKey: queryKeys.chats, queryFn: () => api.listChats() });
}

export function useSettings() {
  const api = useApiClient();
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => api.getSettings() });
}

/** Id of the chat on screen (`#/chat/:id`), or `undefined` elsewhere. */
export function useCurrentChatId(): string | undefined {
  return useMatch('/chat/:id')?.params.id;
}

/**
 * Where "New chat" / `Ctrl+N` go: `#/new`, with the project of the chat on screen preselected (S7.15), if any.
 * Chats without a project, or any other screen, give plain `#/new`.
 */
export function useNewChatPath(): string {
  const currentChatId = useCurrentChatId();
  const chats = useChats();
  const projectId = currentChatId ? chats.data?.find((c) => c.id === currentChatId)?.projectId : null;
  return paths.newChat(projectId);
}
