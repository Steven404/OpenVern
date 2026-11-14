// Files surface (plan §5.1): project name + Collapse all, filter, tree, footer.
// The tree loads lazily: the root listing, plus one listing per expanded folder that is on screen. The filter is a
// debounced server-side search.

import { useProjects } from '@renderer/app/queries';
import { cx } from '@renderer/components/ui';
import { ApiError } from '@renderer/lib/api-client';
import { useApiClient } from '@renderer/lib/api-context';
import type { HomeFileListing, ProjectFileListing } from '@shared/types';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ChevronsDownUp, Folder, Lock, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FileIcon } from '../right-panel/icons';
import { useChatPanelState, usePanelStore } from '../right-panel/panel-store';
import type { SurfaceProps } from '../right-panel/surfaces';
import { folderQuery, retryUnlessClientError, searchQuery } from './queries';
import {
  buildRows,
  FOLDER_ERROR,
  type FolderState,
  type SearchShown,
  searchRows,
  searchTruncationNote,
  searchView,
  type TreeRow,
  visibleExpandedFolders,
} from './tree';

/** Filter text settles this long before a search is sent. */
export const FILTER_DEBOUNCE_MS = 200;

/**
 * `value`, once it has stopped changing for `ms`. When `scope` changes (another chat or root) the new value is used at
 * once, as on a fresh mount: a settled value never carries over to another scope.
 */
function useDebounced<T>(value: T, ms: number, scope: string): T {
  const [settled, setSettled] = useState({ value, scope });
  useEffect(() => {
    const t = setTimeout(() => setSettled({ value, scope }), ms);
    return () => clearTimeout(t);
  }, [value, ms, scope]);
  return settled.scope === scope ? settled.value : value;
}

const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

export function FilesSurface({ chatId, projectId }: SurfaceProps) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const projects = useProjects();
  const state = useChatPanelState(chatId);
  const { setQuery, toggleFolder, collapseAll, openFile } = usePanelStore.getState();
  const pending = projectId === undefined;
  const home = projectId === null;
  // A project not known yet gets keys of its own that are never fetched, so home answers cached under the home keys
  // can't be drawn (or clicked) as if they belonged to this chat.
  const owner = pending ? '' : projectId;
  const query = state.query;
  const raw = query.trim();
  const filtering = raw !== '';
  // Everything the filter remembers is tied to this chat and root, so nothing shown can come from another project.
  const scope = `${chatId}:${pending ? 'pending' : (owner ?? 'home')}`;

  const tree = useQuery({ ...folderQuery(api, owner, ''), enabled: !pending });

  // A folder is fetched once its parent's listing shows it, so a remembered folder that no longer exists is never
  // requested; one that vanishes later answers 404 and is not retried.
  const listingOf = (dir: string): ProjectFileListing | undefined =>
    dir === '' ? tree.data : queryClient.getQueryData<ProjectFileListing>(folderQuery(api, owner, dir).queryKey);
  const folders = visibleExpandedFolders(state.expanded);
  const children = useQueries({
    queries: folders.map((dir) => ({
      ...folderQuery(api, owner, dir),
      enabled:
        !pending &&
        !filtering &&
        (listingOf(parentOf(dir))?.entries.some((e) => e.path === dir && e.type === 'dir') ?? false),
      retry: retryUnlessClientError,
    })),
  });

  const term = useDebounced(raw, FILTER_DEBOUNCE_MS, scope);
  // No placeholder data: `search.data` is always the answer for exactly (owner, term), or nothing yet.
  const search = useQuery({
    ...searchQuery(api, owner, term),
    enabled: !pending && term !== '',
    retry: retryUnlessClientError,
  });
  // The last answer received in this scope, kept so that while the filter grows (a narrower term) it can stay on
  // screen, narrowed to the new text. Forgotten when the filter is cleared.
  const [last, setLast] = useState<SearchShown | null>(null);
  useEffect(() => {
    if (search.data && term !== '') setLast({ scope, term, result: search.data });
  }, [search.data, term, scope]);
  useEffect(() => {
    if (raw === '') setLast(null);
  }, [raw]);
  const current: SearchShown | null = search.data && term !== '' ? { scope, term, result: search.data } : null;
  const view = searchView({
    raw,
    scope,
    current,
    last,
    error: term === raw && search.isError ? search.error : null,
  });

  const projectName = projects.data?.find((p) => p.id === projectId)?.name ?? '';
  const title = home ? ((tree.data as HomeFileListing | undefined)?.root ?? 'Home') : projectName;
  const openPath = state.active?.type === 'file' ? state.active.path : null;

  const folderStates = new Map<string, FolderState>();
  const retryFolder = new Map<string, () => void>();
  for (const [i, dir] of folders.entries()) {
    const q = children[i];
    if (!q) continue;
    retryFolder.set(dir, () => void q.refetch());
    // A folder that vanished (404) is drawn like an empty one; any other failure shows its message and a retry, and
    // reads as loading again while that retry runs.
    const state: FolderState = q.data
      ? { status: 'success', listing: q.data }
      : !q.isError || q.isFetching
        ? { status: 'pending' }
        : q.error instanceof ApiError && q.error.status === 404
          ? { status: 'gone' }
          : { status: 'error', message: q.error instanceof ApiError ? q.error.info.message : FOLDER_ERROR };
    folderStates.set(dir, state);
  }
  // Recomputed every render: `folderStates` is rebuilt from the query results above, which are cheap to walk.
  const treeRows: TreeRow[] = tree.data ? buildRows(tree.data, (dir) => folderStates.get(dir), state.expanded) : [];
  const shownEntries = view.kind === 'results' || view.kind === 'narrowing' ? view.entries : null;
  const hits = shownEntries ? searchRows(shownEntries) : [];
  const rows: TreeRow[] = filtering ? hits : treeRows;
  const truncationNote =
    view.kind === 'results' ? searchTruncationNote(view.truncated, view.entries.length, raw, home) : null;

  return (
    <>
      <div className="flex items-center gap-1 pt-2.5 pr-2 pl-4">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text" title={title}>
          {title}
        </span>
        <button
          type="button"
          aria-label="Collapse all folders"
          title="Collapse all"
          onClick={() => collapseAll(chatId)}
          className="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent text-text-muted hover:bg-overlay-ghost hover:text-text"
        >
          <ChevronsDownUp aria-hidden="true" size={15} strokeWidth={1.8} />
        </button>
      </div>
      <div className="px-3 pt-2.5 pb-1.5">
        <label className="flex h-9 items-center gap-2 rounded-[8px] bg-tool px-2.5 transition-[background-color] focus-within:bg-surface">
          <Search aria-hidden="true" size={15} strokeWidth={2} className="shrink-0 text-text-faint" />
          <input
            type="search"
            aria-label="Filter files"
            placeholder="Filter files"
            value={query}
            onChange={(e) => setQuery(chatId, e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-text placeholder:text-text-faint"
          />
        </label>
      </div>

      <nav
        aria-label={home ? 'Home files' : 'Project files'}
        className="min-h-[120px] flex-1 basis-0 overflow-y-auto px-2 pt-1 pb-2 scrollbar-stable"
      >
        {tree.isPending ? (
          <p className="m-4 text-[13px] text-text-muted">Loading files…</p>
        ) : tree.error ? (
          <div className="m-4 flex flex-col items-start gap-2 text-[13px] text-text-muted">
            <p className="m-0">
              {tree.error instanceof ApiError
                ? tree.error.info.message
                : home
                  ? "Couldn't load your home folder."
                  : "Couldn't load the project files."}
            </p>
            <button
              type="button"
              onClick={() => void tree.refetch()}
              className="cursor-pointer rounded-[6px] border border-transparent bg-overlay-tonal px-2.5 py-1 text-text hover:bg-overlay-tonal-hover"
            >
              Try again
            </button>
          </div>
        ) : filtering && view.kind === 'searching' ? (
          <p className="mx-2.5 my-4 text-[13px] text-text-muted">Searching…</p>
        ) : filtering && view.kind === 'error' ? (
          <p className="mx-2.5 my-4 text-[13px] text-text-muted">
            {view.error instanceof ApiError ? view.error.info.message : "Couldn't search the files."}
          </p>
        ) : rows.length === 0 ? (
          <p className="mx-2.5 my-4 text-[13px] text-text-muted">
            {filtering
              ? (truncationNote?.empty ?? `No files match “${raw}”.`)
              : home
                ? 'This folder is empty.'
                : 'This project has no files.'}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((r) => {
              if (r.kind === 'status') {
                const retry = r.retry === undefined ? undefined : retryFolder.get(r.retry);
                return (
                  <li
                    key={r.key}
                    className={cx(
                      'flex min-h-7 items-center pr-2 text-xs text-text-faint',
                      retry && 'flex-wrap gap-x-2 gap-y-1 py-1',
                    )}
                    style={{ paddingLeft: 26 + r.depth * 14 }}
                  >
                    <span className="min-w-0">{r.text}</span>
                    {retry ? (
                      <button
                        type="button"
                        aria-label={`Try again to load ${r.retry}`}
                        onClick={retry}
                        className="cursor-pointer rounded-[6px] border border-transparent bg-overlay-tonal px-2 py-0.5 text-text-secondary hover:bg-overlay-tonal-hover hover:text-text"
                      >
                        Try again
                      </button>
                    ) : null}
                  </li>
                );
              }
              const expanded = r.isDir && state.expanded[r.path] === true;
              const isCurrent = !r.isDir && r.path === openPath;
              return (
                <li key={r.path}>
                  <button
                    type="button"
                    aria-expanded={r.isDir ? expanded : undefined}
                    aria-current={isCurrent ? 'true' : undefined}
                    title={r.path}
                    onClick={() => (r.isDir ? toggleFolder(chatId, r.path) : openFile(chatId, r.path))}
                    className={cx(
                      'flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-[6px] border-0 pr-2 text-left font-mono text-[12.5px]',
                      isCurrent
                        ? 'bg-surface-raised text-text'
                        : cx('bg-transparent hover:bg-overlay-row', r.isDir ? 'text-text-secondary' : 'text-text-chat'),
                    )}
                    style={{ paddingLeft: 8 + r.depth * 14 }}
                  >
                    <span className={cx('inline-flex w-3 flex-none', !r.isDir && 'invisible')}>
                      <ChevronRight
                        aria-hidden="true"
                        size={12}
                        strokeWidth={2.4}
                        className={cx('text-text-faint transition-transform duration-150', expanded && 'rotate-90')}
                      />
                    </span>
                    {r.isDir ? (
                      <Folder aria-hidden="true" size={15} strokeWidth={1.7} className="flex-none text-accent-2" />
                    ) : (
                      <FileIcon size={15} className="flex-none text-text-faint" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-text-faint">{r.dir}</span>
                      {r.name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {filtering && rows.length > 0 && truncationNote ? (
          <p className="mx-2.5 my-2 text-xs text-text-faint">{truncationNote.note}</p>
        ) : null}
      </nav>

      <footer className="flex items-center gap-2 border-t border-border-header px-3.5 py-[9px] text-xs text-text-muted">
        <Lock aria-hidden="true" size={13} strokeWidth={2} className="shrink-0" />
        <span>Ignored and secret files are hidden (.env, .git, keys)</span>
      </footer>
    </>
  );
}
