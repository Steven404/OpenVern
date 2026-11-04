// Shared server-data hooks for the S6 features (sidebar, header, modals). Keys come from `lib/query-keys.ts`.

import { DRAFT_PANEL_CHAT_ID } from '@renderer/features/right-panel/panel-store';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { NEW_CHAT_PROJECT_PARAM, paths } from '@renderer/lib/routes';
import type { Id } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { useMatch, useSearchParams } from 'react-router';

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
 * The project `#/new?project=<param>` means: the param while it is a known project or the list is still loading,
 * otherwise none. `known` is false for an id missing from a loaded list.
 */
export function resolveNewChatProject(
  param: string | null,
  projects: readonly { id: Id }[] | undefined,
): { projectId: Id | null; known: boolean } {
  const known = param !== null && (projects?.some((p) => p.id === param) ?? false);
  return { projectId: param !== null && (known || !projects) ? param : null, known };
}

/**
 * The chat the right panel belongs to, plus the folder it should list.
 * On `#/new` there is no chat yet (`DRAFT_PANEL_CHAT_ID`); a project in `?project=` is listed, otherwise home.
 */
export function useRightPanelTarget(): { chatId: Id; projectId: Id | null | undefined } | null {
  const currentChatId = useCurrentChatId();
  const onNew = useMatch('/new') !== null;
  const [params] = useSearchParams();
  const projects = useProjects();
  const chats = useChats();

  if (currentChatId) {
    // `undefined` until the chat list arrives, so a project chat doesn't briefly list the home folder.
    if (!chats.data) return { chatId: currentChatId, projectId: undefined };
    return { chatId: currentChatId, projectId: chats.data.find((c) => c.id === currentChatId)?.projectId ?? null };
  }
  if (!onNew) return null;
  const param = params.get(NEW_CHAT_PROJECT_PARAM);
  const { projectId } = resolveNewChatProject(param, projects.data);
  return { chatId: DRAFT_PANEL_CHAT_ID, projectId };
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
