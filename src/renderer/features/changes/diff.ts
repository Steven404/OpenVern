// Pure helpers for the review UI: hunk lines, split pairing, labels and progress (plan §5.2).

import type { AppliedBatch, DiffHunk, FileChange, HunkDecision } from '@shared/types';

export type FileDecisions = Record<string, HunkDecision>;
/** path → hunk id → decision */
export type Decisions = Record<string, FileDecisions>;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/') + 1;
  return { dir: path.slice(0, i), name: path.slice(i) };
}

export const statusLetter = (kind: FileChange['kind']) => (kind === 'create' ? 'A' : kind === 'delete' ? 'D' : 'M');

export type LineType = 'add' | 'del' | 'ctx';
export interface DiffLine {
  /** Position within the hunk (a stable key). */
  i: number;
  type: LineType;
  /** Old line number, null for added lines. */
  o: number | null;
  /** New line number, null for deleted lines. */
  n: number | null;
  code: string;
}

export function parseHunk(h: DiffHunk): DiffLine[] {
  let o = h.oldStart;
  let n = h.newStart;
  return h.lines.map((raw, i): DiffLine => {
    const code = raw.slice(1);
    if (raw[0] === '+') return { i, type: 'add', o: null, n: n++, code };
    if (raw[0] === '-') return { i, type: 'del', o: o++, n: null, code };
    return { i, type: 'ctx', o: o++, n: n++, code };
  });
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pairs consecutive deleted and added lines side by side; context lines appear on both sides. */
export function pairLines(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] as DiffLine;
    if (line.type === 'ctx') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (lines[i]?.type === 'del') dels.push(lines[i++] as DiffLine);
    while (lines[i]?.type === 'add') adds.push(lines[i++] as DiffLine);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

export const hunkRange = (h: DiffHunk) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;

/** Unchanged lines between a hunk and the one before it (0 for the first). */
export function gapBefore(hunks: DiffHunk[], index: number): number {
  const prev = hunks[index - 1];
  const h = hunks[index];
  return prev && h ? Math.max(0, h.oldStart - (prev.oldStart + prev.oldLines)) : 0;
}

export function kindLabel(f: FileChange): string {
  if (f.kind === 'create') return 'New file';
  if (f.kind === 'delete') return 'Deleted file';
  return f.tooLarge ? 'Too large' : plural(f.hunks.length, 'change');
}

export interface Progress {
  total: number;
  accepted: number;
  rejected: number;
  decided: number;
}

export function progressOf(files: FileChange[], decisions: Decisions): Progress {
  let total = 0;
  let accepted = 0;
  let rejected = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      total++;
      const d = decisions[f.path]?.[h.id];
      if (d === 'accepted') accepted++;
      else if (d === 'rejected') rejected++;
    }
  }
  return { total, accepted, rejected, decided: accepted + rejected };
}

export function progressLabel(p: Progress): string {
  return p.decided === p.total && p.total > 0
    ? `All ${p.total} changes reviewed`
    : `${p.decided} of ${p.total} changes reviewed`;
}

export function footerHint(p: Progress): string {
  if (p.decided < p.total) return 'Undecided changes are left out when you apply.';
  return p.rejected > 0 ? `${plural(p.rejected, 'rejected change')} will be dropped.` : 'Ready to write to disk.';
}

export const allRejected = (p: Progress) => p.total > 0 && p.rejected === p.total;

export interface FileState {
  label: string;
  tone: 'ok' | 'bad' | 'neutral';
}

export function fileState(f: FileChange, d: FileDecisions | undefined): FileState {
  const total = f.hunks.length;
  if (total === 0) return { label: '', tone: 'neutral' };
  const accepted = f.hunks.filter((h) => d?.[h.id] === 'accepted').length;
  const decided = f.hunks.filter((h) => d?.[h.id] !== undefined).length;
  if (decided === total) {
    if (accepted === total) return { label: 'Accepted', tone: 'ok' };
    if (accepted === 0) return { label: 'Rejected', tone: 'bad' };
    return { label: 'Partly accepted', tone: 'ok' };
  }
  return { label: decided > 0 ? `${decided} of ${total}` : '', tone: 'neutral' };
}

/** Only hunks that still exist in `files` and carry a decision (the apply body; also prunes stale ids). */
export function buildDecisions(files: FileChange[], decisions: Decisions): Decisions {
  const out: Decisions = {};
  for (const f of files) {
    const per: FileDecisions = {};
    for (const h of f.hunks) {
      const d = decisions[f.path]?.[h.id];
      if (d) per[h.id] = d;
    }
    if (Object.keys(per).length > 0) out[f.path] = per;
  }
  return out;
}

export function appliedLabel(b: AppliedBatch): string {
  const changes = b.written.reduce((n, f) => n + f.hunks.length, 0);
  const base = `Wrote ${plural(changes, 'change')} to ${plural(b.written.length, 'file')}`;
  const rejected = b.rejectedHunks > 0 ? ` · ${b.rejectedHunks} rejected` : '';
  const skipped = b.conflicts.length > 0 ? ` · ${b.conflicts.length} not written (changed on disk)` : '';
  return `${base}${rejected}${skipped}`;
}

export const CONFLICT_LABEL: Record<AppliedBatch['conflicts'][number]['reason'], string> = {
  changed_on_disk: 'Changed on disk',
  deleted_on_disk: 'Deleted on disk',
  exists_on_disk: 'Already exists on disk',
  blocked: 'Blocked',
};
