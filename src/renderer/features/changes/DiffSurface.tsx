// The Diff surface of the right panel (plan §5.2, G5.2–G5.5): changed files, hunks with decisions, the apply bar
// and the read-only list of applied batches.

import { cx } from '@renderer/components/ui';
import { ApiError } from '@renderer/lib/api-client';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { useRunsStore } from '@renderer/stores/runs';
import { useUiStore } from '@renderer/stores/ui';
import { LAYOUT } from '@shared/constants';
import type { DiffHunk, FileChange, PendingChanges } from '@shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, ChevronsUpDown, Columns2, Rows3, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { availablePanelWidth } from '../right-panel/layout';
import { useChatChanges } from '../right-panel/queries';
import type { SurfaceProps } from '../right-panel/surfaces';
import { AppliedList } from './AppliedList';
import {
  allRejected,
  buildDecisions,
  CONFLICT_LABEL,
  type Decisions,
  fileState,
  footerHint,
  gapBefore,
  hunkRange,
  kindLabel,
  plural,
  progressLabel,
  progressOf,
} from './diff';
import { HunkLines, PathLabel, StatusBadge, Totals } from './parts';
import { type DiffMode, useDecisions, useReviewStore, useReviewView } from './review-store';

const STALE_MESSAGE = 'The proposed edits changed while you were reviewing. Review them again.';

function useWindowWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

const ghostBtn =
  'inline-flex cursor-pointer items-center justify-center border-0 bg-transparent text-text-muted hover:bg-overlay-ghost hover:text-text';
const lineBtn =
  'inline-flex cursor-pointer items-center gap-2 border border-border-control bg-transparent text-text-secondary hover:border-border-hover hover:bg-surface-raised-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50';

function HunkBlock({
  chatId,
  pending,
  file,
  hunk,
  index,
  decisions,
  mode,
}: {
  chatId: string;
  pending: PendingChanges;
  file: FileChange;
  hunk: DiffHunk;
  index: number;
  decisions: Decisions;
  mode: DiffMode;
}) {
  const decide = useReviewStore((s) => s.decide);
  const d = decisions[file.path]?.[hunk.id];
  const gap = gapBefore(file.hunks, index);
  const set = (v: 'accepted' | 'rejected' | null) => decide(chatId, pending, file.path, hunk.id, v);
  return (
    <div data-testid="hunk" data-decision={d ?? 'undecided'}>
      {gap > 0 && (
        <div className="flex min-h-[30px] w-full items-center gap-2 border-y border-[#1a2040] bg-[#0d1123] pr-4 pl-[22px] text-[12px] text-text-faint">
          <ChevronsUpDown aria-hidden="true" size={14} strokeWidth={1.8} />
          {plural(gap, 'unchanged line')}
        </div>
      )}
      <div
        className={cx(
          'border-b border-[#1a2142] transition-opacity duration-200',
          d === 'rejected' && 'opacity-[0.42]',
        )}
      >
        <div className="flex flex-wrap items-center gap-2.5 border-b border-[#1a2142] bg-[#121731] py-2 pr-3 pl-4">
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-muted">
            <span className="text-diff-range">{hunkRange(hunk)}</span> {hunk.header}
          </span>
          {d === undefined ? (
            <div className="inline-flex gap-1.5">
              <button
                type="button"
                aria-label="Reject this change"
                onClick={() => set('rejected')}
                className="inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-[8px] border border-border-control bg-transparent px-2.5 text-[12.5px] text-text-secondary hover:border-[#a15b45] hover:bg-[rgb(229_134_95/0.14)] hover:text-[#f8c6b2]"
              >
                <X aria-hidden="true" size={13} strokeWidth={2.2} />
                Reject
              </button>
              <button
                type="button"
                aria-label="Accept this change"
                onClick={() => set('accepted')}
                className="inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-[8px] border border-border-control bg-transparent px-2.5 text-[12.5px] text-text-secondary hover:border-[#5f927a] hover:bg-[rgb(159_212_179/0.16)] hover:text-[#d2efdd]"
              >
                <Check aria-hidden="true" size={13} strokeWidth={2.2} />
                Accept
              </button>
            </div>
          ) : (
            <div className="inline-flex items-center gap-1">
              <span
                className={cx(
                  'inline-flex min-h-6 items-center rounded-full px-[9px] text-[12px] font-medium',
                  d === 'accepted'
                    ? 'bg-[rgb(159_212_179/0.14)] text-[#b5e0c6]'
                    : 'bg-[rgb(229_134_95/0.14)] text-[#f2ad94]',
                )}
              >
                {d === 'accepted' ? 'Accepted' : 'Rejected'}
              </span>
              <button
                type="button"
                aria-label="Undo decision"
                onClick={() => set(null)}
                className={cx(ghostBtn, 'min-h-[30px] rounded-[8px] px-2 text-[12.5px]')}
              >
                Undo
              </button>
            </div>
          )}
        </div>
        <HunkLines hunk={hunk} mode={mode} />
      </div>
    </div>
  );
}

export function DiffSurface({ chatId, params }: SurfaceProps) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const changes = useChatChanges(chatId);
  const pending = changes.data?.pending ?? null;
  const applied = changes.data?.applied ?? [];
  const decisions = useDecisions(chatId, pending);
  const { mode, current } = useReviewView(chatId);
  const { setMode, setCurrent, setAll, clearDecisions } = useReviewStore.getState();
  const streaming = useRunsStore((s) => {
    const st = s.runs[chatId]?.status;
    return st === 'running' || st === 'settling';
  });
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth);
  const windowWidth = useWindowWidth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Split needs a panel at least `splitMin` wide. The panel only widens on an explicit Split click (never on its
  // own), and only when the window has room; otherwise Split is disabled. `windowWidth` is 0 only before it is known.
  const maxWidth = availablePanelWidth(sidebarCollapsed, windowWidth);
  const panelTarget = Math.min(rightPanelWidth, maxWidth);
  const canSplit = windowWidth === 0 || maxWidth >= LAYOUT.splitMin;
  const fits = panelTarget >= LAYOUT.splitMin;
  const effMode: DiffMode = mode === 'split' && fits ? 'split' : 'unified';

  const pick = (m: DiffMode) => {
    if (m === 'split' && !fits && canSplit) {
      setRightPanelWidth(Math.max(rightPanelWidth, Math.min(LAYOUT.panelDiffSplit, maxWidth)));
    }
    setMode(chatId, m);
  };

  // Opened on a file (`openPanelSurface(chatId, 'diff', { path })`); a new params object per call.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the params object on purpose
  useEffect(() => {
    const path = (params as { path?: unknown } | null)?.path;
    if (typeof path === 'string') setCurrent(chatId, path);
  }, [params, chatId]);

  const files = pending?.files ?? [];
  const cur = files.find((f) => f.path === current) ?? files[0];
  const curIndex = cur ? files.indexOf(cur) : -1;
  const next = curIndex >= 0 ? files[curIndex + 1] : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll back to the top when the file changes
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [cur?.path]);

  const conflicts = new Map(applied.at(-1)?.conflicts.map((c) => [c.path, c.reason]) ?? []);
  const progress = progressOf(files, decisions);
  const discarding = pending !== null && allRejected(progress);
  const applyDisabled = !pending || busy || streaming || (!discarding && progress.accepted === 0);

  const act = async () => {
    if (!pending || applyDisabled) return;
    setBusy(true);
    setError(null);
    try {
      const key = queryKeys.chatChanges(chatId);
      if (discarding) {
        queryClient.setQueryData(key, await api.discardChatChanges(chatId));
      } else {
        const res = await api.applyChatChanges(chatId, {
          revision: pending.revision,
          decisions: buildDecisions(pending.files, decisions),
        });
        queryClient.setQueryData(key, res.changes);
      }
      clearDecisions(chatId);
    } catch (err) {
      if (err instanceof ApiError && err.info.code === 'changes_stale') {
        // Decisions for hunk ids that still exist carry over (see review-store).
        try {
          queryClient.setQueryData(queryKeys.chatChanges(chatId), await api.getChatChanges(chatId));
        } catch {
          void queryClient.invalidateQueries({ queryKey: queryKeys.chatChanges(chatId) });
        }
        setError(STALE_MESSAGE);
      } else {
        setError(err instanceof ApiError ? err.info.message : "Couldn't update the edits. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const showFile = (path: string) => setCurrent(chatId, path);

  const header = (
    <header className="flex min-h-[64px] flex-wrap items-center gap-2.5 border-b border-border-header py-3 pr-3 pl-5">
      <h2 className="m-0 text-[15px] font-semibold text-text">Review changes</h2>
      {pending && <Totals add={pending.totalAdd} del={pending.totalDel} />}
      <span className="flex-1" />
      {pending && (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, not a form fieldset
        <div
          role="group"
          aria-label="Diff layout"
          className="inline-flex gap-0.5 rounded-[10px] border border-border-tool bg-[#131932] p-[3px]"
        >
          {(['unified', 'split'] as const).map((m) => {
            const on = effMode === m;
            const disabled = m === 'split' && !canSplit;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                title={disabled ? 'Make the window wider to use Split' : undefined}
                onClick={() => pick(m)}
                className={cx(
                  'inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-[7px] border-0 px-2.5 text-[12.5px] disabled:cursor-not-allowed disabled:opacity-50',
                  on ? 'bg-segment-on text-text shadow-[0_1px_2px_rgb(0_0_0/0.35)]' : 'bg-transparent text-text-muted',
                )}
              >
                {m === 'unified' ? <Rows3 aria-hidden="true" size={14} /> : <Columns2 aria-hidden="true" size={14} />}
                {m === 'unified' ? 'Unified' : 'Split'}
              </button>
            );
          })}
        </div>
      )}
    </header>
  );

  if (!pending) {
    return (
      <section aria-label="Review changes" className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto bg-code [scrollbar-color:var(--color-border-control)_transparent] [scrollbar-width:thin]">
          <p className="m-0 px-5 py-6 text-[13px] text-text-muted">
            {changes.isPending ? 'Loading edits…' : 'No edits are waiting for review.'}
          </p>
          <AppliedList batches={applied} mode={effMode} />
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Review changes" className="flex min-h-0 flex-1 flex-col">
      {header}

      <nav aria-label="Changed files" className="border-b border-border-header p-2.5">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {files.map((f) => {
            const st = fileState(f, decisions[f.path]);
            const conflict = conflicts.get(f.path);
            const isCur = f.path === cur?.path;
            return (
              <li key={f.path}>
                <button
                  type="button"
                  aria-current={isCur}
                  onClick={() => showFile(f.path)}
                  className={cx(
                    'flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-[9px] border-0 px-2.5 text-left text-[13px] text-text-secondary hover:bg-overlay-row',
                    isCur ? 'bg-surface-raised' : 'bg-transparent',
                  )}
                >
                  <StatusBadge kind={f.kind} />
                  <PathLabel path={f.path} />
                  {conflict ? (
                    <span className="whitespace-nowrap text-[12px] text-danger">{CONFLICT_LABEL[conflict]}</span>
                  ) : (
                    st.label && (
                      <span
                        className={cx(
                          'whitespace-nowrap text-[12px]',
                          st.tone === 'ok'
                            ? 'text-diff-add-num'
                            : st.tone === 'bad'
                              ? 'text-diff-del-num'
                              : 'text-text-muted',
                        )}
                      >
                        {st.label}
                      </span>
                    )
                  )}
                  <span className="inline-flex min-w-16 justify-end">
                    <Totals add={f.add} del={f.del} small />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto bg-code [scrollbar-color:var(--color-border-control)_transparent] [scrollbar-width:thin]"
      >
        {cur && (
          <>
            <div className="sticky top-0 z-[1] flex items-center gap-2.5 border-b border-[#1a2142] bg-code px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text" title={cur.path}>
                {cur.path}
              </span>
              <span className="whitespace-nowrap text-[12px] text-text-muted">{kindLabel(cur)}</span>
            </div>
            {cur.tooLarge || cur.hunks.length === 0 ? (
              <p className="m-0 px-5 py-6 text-[13px] text-text-muted">
                {cur.tooLarge
                  ? 'This diff is too large to show here. It cannot be applied from the review pane.'
                  : 'Nothing to show for this file.'}
              </p>
            ) : (
              cur.hunks.map((h, i) => (
                <HunkBlock
                  key={h.id}
                  chatId={chatId}
                  pending={pending}
                  file={cur}
                  hunk={h}
                  index={i}
                  decisions={decisions}
                  mode={effMode}
                />
              ))
            )}
            {next && (
              <div className="flex justify-end p-4">
                <button
                  type="button"
                  onClick={() => showFile(next.path)}
                  className={cx(lineBtn, 'min-h-[34px] rounded-[10px] px-3 text-[13px]')}
                >
                  Next file
                  <ArrowRight aria-hidden="true" size={14} strokeWidth={2} />
                </button>
              </div>
            )}
          </>
        )}
        <AppliedList batches={applied} mode={effMode} />
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border py-3 pr-3.5 pl-5">
        <div className="flex min-w-40 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium text-text">{progressLabel(progress)}</span>
          <span className="text-[12px] text-text-muted" role={error ? 'alert' : undefined}>
            {error ?? (streaming ? 'Wait for the reply to finish.' : footerHint(progress))}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setAll(chatId, pending, 'rejected')}
          className={cx(ghostBtn, 'min-h-[38px] rounded-[10px] px-3 text-[13.5px] text-text-secondary')}
        >
          Reject all
        </button>
        <button
          type="button"
          onClick={() => setAll(chatId, pending, 'accepted')}
          className={cx(lineBtn, 'min-h-[38px] rounded-[10px] px-3 text-[13.5px] text-text')}
        >
          Accept all
        </button>
        <button
          type="button"
          disabled={applyDisabled}
          aria-busy={busy || undefined}
          onClick={() => void act()}
          className="inline-flex min-h-[38px] cursor-pointer items-center gap-2 rounded-[10px] border-0 bg-accent px-3.5 text-[13.5px] font-semibold text-bg hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check aria-hidden="true" size={15} strokeWidth={2.2} />
          {discarding ? 'Discard' : progress.accepted === 0 ? 'Apply' : `Apply ${progress.accepted}`}
        </button>
      </footer>
    </section>
  );
}
