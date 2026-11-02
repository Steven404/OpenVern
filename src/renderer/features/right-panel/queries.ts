import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import type { Id } from '@shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

/** The chat's proposed / applied edits. G5 keeps this query fresh from `changes_updated`. */
export function useChatChanges(chatId: Id) {
  const api = useApiClient();
  return useQuery({ queryKey: queryKeys.chatChanges(chatId), queryFn: () => api.getChatChanges(chatId) });
}

/** Diff launcher rule: pending or applied edits exist. */
export function useHasChanges(chatId: Id): boolean {
  const { data } = useChatChanges(chatId);
  return data ? data.pending !== null || data.applied.length > 0 : false;
}

/**
 * Refetches the Files tree and open files when the panel opens and whenever a new batch gets applied (the files on
 * disk changed).
 */
export function useRefreshProjectFiles(chatId: Id, projectId: Id | null): void {
  const queryClient = useQueryClient();
  const { data } = useChatChanges(chatId);
  const applied = data?.applied.length;
  const last = useRef(applied);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount (panel open) and project change
  useEffect(() => {
    if (!projectId) return;
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
