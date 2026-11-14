// Files panel queries: one listing per folder (lazy), and the filter's server-side search.

import { type ApiClient, ApiError } from '@renderer/lib/api-client';
import { queryKeys } from '@renderer/lib/query-keys';
import type { HomeFileListing, Id, ProjectFileListing, ProjectFileSearchResult } from '@shared/types';

/** Folder listing of a project, or of home when `projectId` is null. The root (`''`) is shared with the file viewer. */
export function folderQuery(api: ApiClient, projectId: Id | null, dir: string) {
  return {
    queryKey: projectId === null ? queryKeys.homeFolder(dir) : queryKeys.projectFolder(projectId, dir),
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<ProjectFileListing | HomeFileListing> =>
      projectId === null ? api.listHomeFiles(dir, signal) : api.listProjectFiles(projectId, dir, signal),
  };
}

export function searchQuery(api: ApiClient, projectId: Id | null, term: string) {
  return {
    queryKey: projectId === null ? queryKeys.homeFileSearch(term) : queryKeys.projectFileSearch(projectId, term),
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<ProjectFileSearchResult> =>
      projectId === null ? api.searchHomeFiles(term, signal) : api.searchProjectFiles(projectId, term, signal),
  };
}

/**
 * Retry policy for folder and search queries: a 4xx (a folder that is gone, a path the server refuses) won't change
 * on retry, so only network and server errors get the one default retry. Keeps stale expanded folders quiet.
 */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status !== undefined && error.status < 500) return false;
  return failureCount < 1;
}
