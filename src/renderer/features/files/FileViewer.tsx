// Open file tab (plan §5.1): breadcrumb, line count, Attach, and the code with line numbers.

import { useProjects } from '@renderer/app/queries';
import { ApiError } from '@renderer/lib/api-client';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import type { Id } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { addAttachmentRef } from '../composer';
import { type HighlightedLine, highlightCode } from '../conversation/highlight';

/** Highlighting a huge file would add thousands of spans for little value. */
const HIGHLIGHT_MAX_LINES = 3000;

const extension = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
};

export function FileViewer({
  chatId,
  projectId,
  path,
  onBack,
}: {
  chatId: Id;
  projectId: Id | null | undefined;
  path: string;
  onBack: () => void;
}) {
  const api = useApiClient();
  const projects = useProjects();
  const home = projectId === null;
  const homeTree = useQuery({
    queryKey: queryKeys.homeFiles,
    queryFn: () => api.listHomeFiles(),
    enabled: home,
  });
  const projectName = home
    ? (homeTree.data?.root ?? 'Home')
    : (projects.data?.find((p) => p.id === projectId)?.name ?? 'Files');
  const file = useQuery({
    queryKey: home ? queryKeys.homeFile(path) : queryKeys.projectFile(projectId ?? '', path),
    queryFn: () => (home ? api.readHomeFile(path) : api.readProjectFile(projectId as Id, path)),
    enabled: projectId !== undefined,
  });
  const content = file.data?.content ?? null;
  const lines = useMemo(() => {
    if (content === null) return [];
    const all = content.split('\n');
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    return all;
  }, [content]);

  const [tokens, setTokens] = useState<HighlightedLine[] | null>(null);
  useEffect(() => {
    setTokens(null);
    if (content === null || lines.length > HIGHLIGHT_MAX_LINES) return;
    let cancelled = false;
    void highlightCode(content, extension(path)).then((t) => {
      if (!cancelled && t && t.length >= lines.length) setTokens(t);
    });
    return () => {
      cancelled = true;
    };
  }, [content, lines.length, path]);

  const [attach, setAttach] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different file starts with a clean state
  useEffect(() => setAttach({ busy: false, error: null }), [path]);
  const onAttach = async () => {
    setAttach({ busy: true, error: null });
    try {
      const ref = home ? await api.attachHomeFile(path) : await api.attachProjectFile(projectId as Id, path);
      if (!addAttachmentRef(chatId, ref)) {
        void api.deleteAttachment(ref.id).catch(() => {});
        setAttach({ busy: false, error: "Couldn't find the message box." });
        return;
      }
      setAttach({ busy: false, error: null });
    } catch (err) {
      setAttach({
        busy: false,
        error: err instanceof ApiError ? err.info.message : "Couldn't attach this file.",
      });
    }
  };

  const slash = path.lastIndexOf('/') + 1;
  const dir = path.slice(0, slash);
  const name = path.slice(slash);
  const truncated = file.data?.truncated === true;

  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-border-header py-2 pr-2 pl-4">
        <nav
          aria-label="File path"
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[12.5px] whitespace-nowrap"
        >
          <button
            type="button"
            onClick={onBack}
            className="max-w-[40%] cursor-pointer truncate rounded-[5px] border-0 bg-transparent px-1 py-0.5 font-semibold text-text hover:bg-overlay-tonal"
          >
            {projectName}
          </button>
          <ChevronRight aria-hidden="true" size={12} strokeWidth={2.4} className="flex-none text-text-faint" />
          <span className="min-w-0 truncate font-mono text-text-muted" title={path}>
            {dir}
            <span className="text-text">{name}</span>
          </span>
        </nav>
        {file.data ? (
          <span className="font-mono text-[11.5px] whitespace-nowrap text-text-faint">
            {file.data.totalLines} {file.data.totalLines === 1 ? 'line' : 'lines'}
          </span>
        ) : null}
        <button
          type="button"
          title="Attach to message"
          disabled={!file.data || file.data.binary || attach.busy}
          onClick={() => void onAttach()}
          className="inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-[6px] border-0 bg-transparent px-[9px] text-[12.5px] text-text-secondary hover:bg-overlay-ghost hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus aria-hidden="true" size={13} strokeWidth={2.2} />
          Attach
        </button>
      </div>
      {attach.error ? (
        <p role="alert" className="m-0 border-b border-border-header px-4 py-1.5 text-xs text-danger">
          {attach.error}
        </p>
      ) : null}
      <div
        role="tabpanel"
        aria-label={path}
        className="min-h-0 flex-1 overflow-auto bg-code pt-2 pb-6 scrollbar-stable"
      >
        {file.isPending ? (
          <p className="m-4 text-[13px] text-text-muted">Loading {name}…</p>
        ) : file.error ? (
          <p className="m-4 text-[13px] text-text-muted">
            {file.error instanceof ApiError ? file.error.info.message : "Couldn't open this file."}
          </p>
        ) : file.data?.binary ? (
          <p className="m-4 text-[13px] text-text-muted">This is a binary file, so it can't be shown here.</p>
        ) : (
          <>
            <div className="w-max min-w-full">
              {lines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity; the list is replaced whole
                <div key={i} className="flex font-mono text-[12.5px] leading-5 text-text-code hover:bg-overlay-row/70">
                  <span className="w-12 flex-none pr-3.5 text-right text-[#8590b4] tabular-nums select-none">
                    {i + 1}
                  </span>
                  <span className="pr-5 whitespace-pre">
                    {tokens?.[i]
                      ? tokens[i].map((t, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                          <span key={j} style={{ color: t.color }}>
                            {t.content}
                          </span>
                        ))
                      : line}
                  </span>
                </div>
              ))}
            </div>
            {truncated ? (
              <p className="mx-4 mt-3 text-xs text-text-faint">
                This file is large, so only the first {lines.length} of {file.data?.totalLines} lines are shown.
              </p>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
