// The Diff panel's History: every batch of written edits, newest first. Review batches (what the user applied) show
// their apply summary; auto batches (what the model wrote during one Auto turn) show "Auto · {time}" with Undo or
// their undo result. Files expand to their diff.

import type { AppliedBatch, Id } from '@shared/types';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { appliedLabel, CONFLICT_LABEL, hunkRange } from './diff';
import { HunkLines, PathLabel, StatusBadge, Totals } from './parts';
import type { DiffMode } from './review-store';
import { UndoControl, UndoSkippedList } from './UndoDialog';

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A request to show one batch (and open one of its files), from a card's file row. `token` is the panel params object,
 * new on every `openPanelSurface` call, so clicking the same row again scrolls again.
 */
export interface HistoryFocus {
  batchId: Id;
  path?: string;
  token: unknown;
}

/**
 * Scrolls the nearest scrolling ancestor so `row` sits at its top. Only that container moves: `scrollIntoView` would
 * also scroll the panel and the window around it.
 */
function scrollToTop(row: HTMLElement): void {
  let box = row.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box) return;
  box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top;
}

function AppliedFile({
  file,
  mode,
  openToken,
}: {
  file: AppliedBatch['written'][number];
  mode: DiffMode;
  /** Set (a new value per request) when a card asked to open this file. */
  openToken?: unknown;
}) {
  const [open, setOpen] = useState(openToken !== undefined);
  useEffect(() => {
    if (openToken !== undefined) setOpen(true);
  }, [openToken]);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-[7px] border-0 bg-transparent px-4 text-left text-[13px] text-text-secondary hover:bg-overlay-row"
      >
        <ChevronRight
          aria-hidden="true"
          size={13}
          className={`flex-none text-text-faint transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <StatusBadge kind={file.kind} />
        <PathLabel path={file.path} />
        <Totals add={file.add} del={file.del} small />
      </button>
      {open &&
        (file.tooLarge ? (
          <p className="m-0 border-t border-[#1a2142] px-4 py-3 text-[13px] text-text-muted">
            This diff is too large to show here.
          </p>
        ) : (
          file.hunks.map((h) => (
            <div key={h.id} className="border-t border-[#1a2142]">
              <div className="truncate bg-[#121731] px-4 py-1.5 font-mono text-[12px] text-text-muted">
                <span className="text-diff-range">{hunkRange(h)}</span> {h.header}
              </div>
              <HunkLines hunk={h} mode={mode} />
            </div>
          ))
        ))}
    </li>
  );
}

function BatchHeader({ chatId, batch }: { chatId: Id; batch: AppliedBatch }) {
  if (batch.source !== 'auto') {
    return (
      <div className="flex items-center gap-2 px-4 pb-1 text-[13px] text-text-secondary">
        <span className="min-w-0 flex-1">{appliedLabel(batch)}</span>
        <span className="font-mono text-[11.5px] text-text-faint">{timeLabel(batch.appliedAt)}</span>
      </div>
    );
  }
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-1 text-[13px] text-text-secondary">
      <span className="min-w-0 flex-1">
        <span className="font-medium text-accent-2">Auto</span>
        <span className="text-text-faint"> · </span>
        <span className="font-mono text-[11.5px] text-text-faint">{timeLabel(batch.appliedAt)}</span>
      </span>
      <UndoControl chatId={chatId} batch={batch} variant="history" />
    </div>
  );
}

export function AppliedList({
  chatId,
  batches,
  mode = 'unified',
  focus,
}: {
  chatId: Id;
  batches: AppliedBatch[];
  mode?: DiffMode;
  focus?: HistoryFocus;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  // Each focus request scrolls once, as soon as its batch is in the list (the changes may still be loading when the
  // panel opens). Later refetches of the same request don't scroll the user away again.
  const handled = useRef<unknown>(undefined);
  const focusFound = focus !== undefined && batches.some((b) => b.id === focus.batchId);
  useEffect(() => {
    if (!focus || !focusFound || handled.current === focus.token) return;
    const row = Array.from(listRef.current?.children ?? []).find(
      (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.batchId === focus.batchId,
    );
    if (!row) return;
    // Next frame: the Diff surface resets its scroll to the top when it mounts or its file changes, and that effect
    // runs after this one (parents run after children). The request counts as handled only once it has scrolled, so
    // a cleanup that cancels the frame (a re-render, or dev mode running effects twice) doesn't lose it.
    const frame = requestAnimationFrame(() => {
      handled.current = focus.token;
      scrollToTop(row);
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, focusFound]);

  if (batches.length === 0) return null;
  const newestFirst = [...batches].reverse();
  return (
    <section aria-label="History" className="border-t border-border-header">
      <h3 className="m-0 px-4 pt-4 pb-2 text-[13px] font-semibold text-text-muted">History</h3>
      <ul ref={listRef} className="m-0 flex list-none flex-col gap-3 p-0 pb-4">
        {newestFirst.map((b) => (
          <li
            key={b.id}
            data-testid="applied-batch"
            data-source={b.source}
            data-batch-id={b.id}
            className="flex flex-col"
          >
            <BatchHeader chatId={chatId} batch={b} />
            <ul className="m-0 flex list-none flex-col p-0">
              {b.written.map((f) => (
                <AppliedFile
                  key={f.path}
                  file={f}
                  mode={mode}
                  openToken={focus?.batchId === b.id && focus.path === f.path ? focus.token : undefined}
                />
              ))}
            </ul>
            {b.conflicts.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-0.5 px-4 pt-1 p-0">
                {b.conflicts.map((c) => (
                  <li key={c.path} className="flex gap-2 text-[12.5px] text-danger">
                    <span className="min-w-0 flex-1 truncate font-mono" title={c.path}>
                      {c.path}
                    </span>
                    <span>{CONFLICT_LABEL[c.reason]}</span>
                  </li>
                ))}
              </ul>
            )}
            {b.undo && b.undo.skipped.length > 0 && <UndoSkippedList skipped={b.undo.skipped} className="px-4 pt-1" />}
          </li>
        ))}
      </ul>
    </section>
  );
}
