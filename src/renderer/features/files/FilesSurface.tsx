// Files surface (plan §5.1): project name + Collapse all, filter, tree, footer.

import { useProjects } from '@renderer/app/queries';
import { cx } from '@renderer/components/ui';
import { ApiError } from '@renderer/lib/api-client';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import type { HomeFileTree } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ChevronsDownUp, Folder, Lock, Search } from 'lucide-react';
import { useMemo } from 'react';
import { FileIcon } from '../right-panel/icons';
import { useChatPanelState, usePanelStore } from '../right-panel/panel-store';
import type { SurfaceProps } from '../right-panel/surfaces';
import { buildRows } from './tree';

export function FilesSurface({ chatId, projectId }: SurfaceProps) {
  const api = useApiClient();
  const projects = useProjects();
  const state = useChatPanelState(chatId);
  const { setQuery, toggleFolder, collapseAll, openFile } = usePanelStore.getState();
  const pending = projectId === undefined;
  const home = projectId === null;
  const tree = useQuery({
    queryKey: home ? queryKeys.homeFiles : queryKeys.projectFiles(projectId ?? ''),
    queryFn: () => (home ? api.listHomeFiles() : api.listProjectFiles(projectId as string)),
    enabled: !pending,
  });
  const projectName = projects.data?.find((p) => p.id === projectId)?.name ?? '';
  const title = home ? ((tree.data as HomeFileTree | undefined)?.root ?? 'Home') : projectName;
  const current = state.active?.type === 'file' ? state.active.path : null;
  const query = state.query;
  const rows = useMemo(
    () => buildRows(tree.data?.entries ?? [], state.expanded, query),
    [tree.data, state.expanded, query],
  );
  const filtering = query.trim() !== '';

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
          className="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent text-text-muted hover:bg-overlay-ghost hover:text-text"
        >
          <ChevronsDownUp aria-hidden="true" size={15} strokeWidth={1.8} />
        </button>
      </div>
      <div className="px-3 pt-2.5 pb-1.5">
        <label className="flex h-9 items-center gap-2 rounded-[10px] border border-border-tool bg-tool px-2.5 transition-colors focus-within:border-border-focus">
          <Search aria-hidden="true" size={15} strokeWidth={2} className="shrink-0 text-text-faint" />
          <input
            type="search"
            aria-label="Filter files"
            placeholder="Filter files"
            value={query}
            onChange={(e) => setQuery(chatId, e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-text outline-none placeholder:text-text-faint focus-visible:outline-none"
          />
        </label>
      </div>

      <nav
        aria-label={home ? 'Home files' : 'Project files'}
        className="min-h-[120px] flex-1 basis-0 overflow-y-auto px-2 pt-1 pb-2 [scrollbar-color:var(--color-border-control)_transparent] [scrollbar-width:thin]"
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
              className="cursor-pointer rounded-[8px] border border-border-control bg-transparent px-2.5 py-1 text-text-secondary hover:bg-overlay-ghost"
            >
              Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="mx-2.5 my-4 text-[13px] text-text-muted">
            {filtering ? `No files match “${query}”.` : home ? 'This folder is empty.' : 'This project has no files.'}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((r) => {
              const expanded = r.isDir && state.expanded[r.path] === true;
              const isCurrent = !r.isDir && r.path === current;
              return (
                <li key={r.path}>
                  <button
                    type="button"
                    aria-expanded={r.isDir ? expanded : undefined}
                    aria-current={isCurrent ? 'true' : undefined}
                    title={r.path}
                    onClick={() => (r.isDir ? toggleFolder(chatId, r.path) : openFile(chatId, r.path))}
                    className={cx(
                      'flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-[7px] border-0 pr-2 text-left font-mono text-[12.5px]',
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
        {tree.data?.truncated ? (
          <p className="mx-2.5 my-2 text-xs text-text-faint">
            {home ? 'This folder is large' : 'This project is large'}, so only part of it is listed. Use the filter to
            narrow it down.
          </p>
        ) : null}
      </nav>

      <footer className="flex items-center gap-2 border-t border-border-header px-3.5 py-[9px] text-xs text-text-muted">
        <Lock aria-hidden="true" size={13} strokeWidth={2} className="shrink-0" />
        <span>Ignored and secret files are hidden (.env, .git, keys)</span>
      </footer>
    </>
  );
}
