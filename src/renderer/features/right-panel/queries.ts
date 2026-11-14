import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import type { Id } from '@shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { DRAFT_PANEL_CHAT_ID } from './panel-store';

/** The chat's proposed / applied edits. G5 keeps this query fresh from `changes_updated`. */
export function useChatChanges(chatId: Id) {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.chatChanges(chatId),
    queryFn: () => api.getChatChanges(chatId),
    enabled: chatId !== DRAFT_PANEL_CHAT_ID,
  });
}

/** Diff launcher rule: pending or applied edits exist. */
export function useHasChanges(chatId: Id): boolean {
  const { data } = useChatChanges(chatId);
  return data ? data.pending !== null || data.applied.length > 0 : false;
}

/**
 * Refetches the Files panel (open folders, the filter's search, open files) when the panel opens, and for a project
 * whenever a new batch gets applied (the files on disk changed). Only listings that are on screen refetch: the
 * invalidation is by prefix, and react-query refetches active queries only. The home folder (a chat without a
 * project, `projectId === null`) has no applied batches, so it refreshes on panel open only. `undefined` = the chat's
 * project isn't known yet: nothing to refresh.
 */
export function useRefreshProjectFiles(chatId: Id, projectId: Id | null | undefined): void {
  const queryClient = useQueryClient();
  const { data } = useChatChanges(chatId);
  const applied = data?.applied.length;
  const last = useRef(applied);

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
    last.current = applied;
    if (!projectId || applied === undefined || before === undefined || applied <= before) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectFiles(projectId) });
    void queryClient.invalidateQueries({ queryKey: ['projectFile', projectId] });
  }, [applied, projectId, queryClient]);
}
