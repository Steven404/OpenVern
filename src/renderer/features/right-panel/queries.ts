import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import type { Chat, EditMode, Id } from '@shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { DRAFT_PANEL_CHAT_ID } from './panel-store';

/** The chat's proposed / written edits. The runs store keeps it fresh from `changes_updated` and `auto_batch_updated`. */
export function useChatChanges(chatId: Id) {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.chatChanges(chatId),
    queryFn: () => api.getChatChanges(chatId),
    enabled: chatId !== DRAFT_PANEL_CHAT_ID,
  });
}

/**
 * The chat's edit mode, from the chat query the conversation holds. `undefined` while it loads, and for the new-chat
 * screen, which has no chat yet.
 */
export function useChatEditMode(chatId: Id): EditMode | undefined {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.chat(chatId),
    queryFn: () => api.getChat(chatId),
    enabled: chatId !== DRAFT_PANEL_CHAT_ID,
    select: (chat: Chat) => chat.editMode,
  }).data;
}

/** Diff launcher rule: pending or applied edits exist. */
export function useHasChanges(chatId: Id): boolean {
  const { data } = useChatChanges(chatId);
  return data ? data.pending !== null || data.applied.length > 0 : false;
}

/**
 * Refetches the Files panel (open folders, the filter's search, open files) when the panel opens, and for a project
 * whenever the chat changed files on disk (an apply, an Auto write, an undo). Only listings that are on screen
 * refetch: the invalidation is by prefix, and react-query refetches active queries only. The home folder (a chat
 * without a project, `projectId === null`) is never written to, so it refreshes on panel open only. `undefined` = the
 * chat's project isn't known yet: nothing to refresh.
 */
export function useRefreshProjectFiles(chatId: Id, projectId: Id | null | undefined): void {
  const queryClient = useQueryClient();
  const { data } = useChatChanges(chatId);
  // INVARIANT: the refresh keys on `diskSeq`, never on the length of `applied`. That list is capped (the oldest
  // batches drop off), an Auto turn grows a batch in place, and an undo changes files without adding one, so its
  // length can stay the same while the disk changes. `diskSeq` bumps on every change and only goes up.
  const diskSeq = data?.diskSeq;
  const last = useRef(diskSeq);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount (panel open) and project change
  useEffect(() => {
    if (projectId === undefined) return;
    if (projectId === null) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.homeFiles });
      void queryClient.invalidateQueries({ queryKey: ['homeFile'] });
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectFiles(projectId) });
    void queryClient.invalidateQueries({ queryKey: ['projectFile', projectId] });
  }, [projectId]);

  useEffect(() => {
    const before = last.current;
    last.current = diskSeq;
    if (!projectId || diskSeq === undefined || before === undefined || diskSeq <= before) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectFiles(projectId) });
    void queryClient.invalidateQueries({ queryKey: ['projectFile', projectId] });
  }, [diskSeq, projectId, queryClient]);
}
