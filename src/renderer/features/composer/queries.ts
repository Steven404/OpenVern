// Query hooks shared by the composer, new-chat screen and conversation (keys come from the S6/S7 seam).

import type { Id } from '@shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useApiClient } from '../../lib/api-context';
import { queryKeys } from '../../lib/query-keys';
import { chatQueryOptions } from '../../stores/edit-modes';
import type { RunDeps } from '../../stores/runs';
import { getTerminalBridge } from '../terminal/bridge';

export function useSettings() {
  const api = useApiClient();
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => api.getSettings(), staleTime: 60_000 });
}

export function useModels(enabled = true) {
  const api = useApiClient();
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: () => api.listModels(),
    staleTime: 10 * 60_000,
    retry: false,
    enabled,
  });
}

export function useProjects() {
  const api = useApiClient();
  return useQuery({ queryKey: queryKeys.projects, queryFn: () => api.listProjects() });
}

export function useChat(chatId: Id) {
  const api = useApiClient();
  return useQuery(chatQueryOptions(api, chatId));
}

/** Dependencies the runs store needs to talk to the server and patch caches. */
export function useRunDeps(): RunDeps {
  const api = useApiClient();
  const queryClient = useQueryClient();
  // `terminal` present = this client can answer `read_terminal` (Electron with the preload bridge; terminal plan §4.2).
  return useMemo(() => ({ api, queryClient, terminal: getTerminalBridge() ?? undefined }), [api, queryClient]);
}
