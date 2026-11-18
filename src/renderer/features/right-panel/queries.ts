import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { chatQueryOptions, useEditModeEntry } from '@renderer/stores/edit-modes';
import type { EditMode, Id } from '@shared/types';
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
 * The chat's shown edit mode (`stores/edit-modes.ts`), the one the chip shows. `undefined` until the chat was read,
 * and for the new-chat screen, which has no chat yet.
 */
export function useChatEditMode(chatId: Id): EditMode | undefined {
  const api = useApiClient();
  // Subscribed so the chat is read (and its mode fed to the store) even where nothing else mounts the query.
  useQuery({ ...chatQueryOptions(api, chatId), enabled: chatId !== DRAFT_PANEL_CHAT_ID });
  return useEditModeEntry(chatId).mode ?? undefined;
}

/** Diff launcher rule: pending or applied edits exist. */
export function useHasChanges(chatId: Id): boolean {
  const { data } = useChatChanges(chatId);
  return data ? data.pending !== null || data.applied.length > 0 : false;
}

/**
 * Refetches the Files panel (open folders, the filter's search, open files) when the panel opens, when it shows
 * another chat, and for a project whenever the chat changed files on disk (an apply, an Auto write, an undo). Only
 * listings that are on screen refetch: the invalidation is by prefix, and react-query refetches active queries only.
 * The home folder (a chat without a project, `projectId === null`) is never written to, so it refreshes on panel open
 * and chat switch only. `undefined` = the chat's project isn't known yet: nothing to refresh.
 */
export function useRefreshProjectFiles(chatId: Id, projectId: Id | null | undefined): void {
  const queryClient = useQueryClient();
  const { data } = useChatChanges(chatId);
  // INVARIANT: the refresh keys on `diskSeq`, never on the length of `applied`. That list is capped (the oldest
  // batches drop off), an Auto turn grows a batch in place, and an undo changes files without adding one, so its
  // length can stay the same while the disk changes. `diskSeq` bumps on every change and only goes up.
  // INVARIANT: a `diskSeq` is only compared with an earlier one of the same chat. Each chat counts its own changes,
  // so another chat's number says nothing about this one; and while the panel showed another chat, this chat (or any
  // other chat of the project) may have written files. A chat switch therefore refreshes outright and starts a new
  // baseline.
  const diskSeq = data?.diskSeq;
  const last = useRef<{ chatId: Id; diskSeq: number | undefined }>({ chatId, diskSeq });

  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount (panel open), chat switch and project change
  useEffect(() => {
    if (projectId === undefined) return;
    if (projectId === null) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.homeFiles });
      void queryClient.invalidateQueries({ queryKey: ['homeFile'] });
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectFiles(projectId) });
    void queryClient.invalidateQueries({ queryKey: ['projectFile', projectId] });
  }, [chatId, projectId]);

  useEffect(() => {
    const before = last.current;
    last.current = { chatId, diskSeq };
    // Another chat's number is no baseline; the switch itself refreshed (above).
    if (before.chatId !== chatId) return;
    if (!projectId || diskSeq === undefined || before.diskSeq === undefined || diskSeq <= before.diskSeq) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectFiles(projectId) });
    void queryClient.invalidateQueries({ queryKey: ['projectFile', projectId] });
  }, [chatId, diskSeq, projectId, queryClient]);
}
