// Earlier batches of applied edits, read-only, newest first (G5.5). Takes plain `AppliedBatch[]` so it can be reused
// wherever written changes need showing (e.g. auto mode later).

import type { AppliedBatch } from '@shared/types';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { appliedLabel, CONFLICT_LABEL, hunkRange } from './diff';
import { HunkLines, PathLabel, StatusBadge, Totals } from './parts';
import type { DiffMode } from './review-store';

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function AppliedFile({ file, mode }: { file: AppliedBatch['written'][number]; mode: DiffMode }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-4 text-left text-[13px] text-text-secondary hover:bg-overlay-row"
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
        file.hunks.map((h) => (
          <div key={h.id} className="border-t border-[#1a2142]">
            <div className="truncate bg-[#121731] px-4 py-1.5 font-mono text-[12px] text-text-muted">
              <span className="text-diff-range">{hunkRange(h)}</span> {h.header}
            </div>
            <HunkLines hunk={h} mode={mode} />
          </div>
        ))}
    </li>
  );
}

export function AppliedList({ batches, mode = 'unified' }: { batches: AppliedBatch[]; mode?: DiffMode }) {
  if (batches.length === 0) return null;
  const newestFirst = [...batches].reverse();
  return (
    <section aria-label="Applied" className="border-t border-border-header">
      <h3 className="m-0 px-4 pt-4 pb-2 font-mono text-[11px] font-medium tracking-[0.12em] text-text-muted uppercase">
        Applied
      </h3>
      <ul className="m-0 flex list-none flex-col gap-3 p-0 pb-4">
        {newestFirst.map((b) => (
          <li key={b.id} data-testid="applied-batch" className="flex flex-col">
            <div className="flex items-center gap-2 px-4 pb-1 text-[13px] text-text-secondary">
              <span className="min-w-0 flex-1">{appliedLabel(b)}</span>
              <span className="font-mono text-[11.5px] text-text-faint">{timeLabel(b.appliedAt)}</span>
            </div>
            <ul className="m-0 flex list-none flex-col p-0">
              {b.written.map((f) => (
                <AppliedFile key={f.path} file={f} mode={mode} />
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
          </li>
        ))}
      </ul>
    </section>
  );
}
