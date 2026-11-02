// Small building blocks shared by the card, the Diff surface and the Applied list.

import { cx } from '@renderer/components/ui';
import type { ChangeKind } from '@shared/types';
import { type DiffLine, pairLines, parseHunk, splitPath, statusLetter } from './diff';
import type { DiffMode } from './review-store';

const badgeTone: Record<ChangeKind, string> = {
  create: 'bg-[rgb(159_212_179/0.14)] text-success',
  modify: 'bg-[rgb(246_189_96/0.12)] text-accent',
  delete: 'bg-[rgb(255_143_135/0.14)] text-danger',
};
const badgeName: Record<ChangeKind, string> = { create: 'Added', modify: 'Modified', delete: 'Deleted' };

/** A / M / D status badge. */
export function StatusBadge({ kind }: { kind: ChangeKind }) {
  return (
    <span
      role="img"
      aria-label={badgeName[kind]}
      className={cx(
        'inline-flex size-5 flex-none items-center justify-center rounded-[6px] font-mono text-[11px] font-medium',
        badgeTone[kind],
      )}
    >
      {statusLetter(kind)}
    </span>
  );
}

/** Dimmed directory + bright file name. */
export function PathLabel({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={path}>
      <span className="text-text-faint">{dir}</span>
      <span className="text-text">{name}</span>
    </span>
  );
}

/** +a −d */
export function Totals({ add, del, small = false }: { add: number; del: number; small?: boolean }) {
  return (
    <span className={cx('inline-flex gap-1.5 font-mono tabular-nums', small ? 'text-[11.5px]' : 'gap-2 text-[12px]')}>
      <span className={small ? 'text-diff-add-num' : 'text-success'}>+{add}</span>
      <span className={small ? 'text-diff-del-num' : 'text-diff-del-sign'}>−{del}</span>
    </span>
  );
}

const rowTone = {
  add: 'bg-diff-add-bg text-diff-add-text',
  del: 'bg-diff-del-bg text-diff-del-text',
  ctx: '',
  none: '',
} as const;
const numTone = {
  add: 'bg-diff-add-num-bg text-diff-add-num',
  del: 'bg-diff-del-num-bg text-diff-del-num',
  ctx: 'text-text-faint',
  none: 'text-text-faint',
} as const;
const signTone = {
  add: 'text-diff-add-sign',
  del: 'text-diff-del-sign',
  ctx: 'text-text-faint',
  none: 'text-text-faint',
} as const;
const HATCH = 'repeating-linear-gradient(135deg, transparent 0 6px, rgb(200 215 255 / 0.025) 6px 12px)';

const num = 'w-10 flex-none select-none box-border pr-2 text-right tabular-nums';
const sign = 'w-[18px] flex-none select-none text-center';
const code = 'min-w-0 flex-1 pr-4 whitespace-pre-wrap [overflow-wrap:anywhere]';

function UnifiedRow({ line }: { line: DiffLine }) {
  return (
    <div
      data-line={line.type}
      className={cx('flex items-start font-mono text-[12.5px] leading-5 text-diff-text', rowTone[line.type])}
    >
      <span className={cx(num, numTone[line.type])}>{line.o ?? ''}</span>
      <span className={cx(num, numTone[line.type])}>{line.n ?? ''}</span>
      <span className={cx(sign, signTone[line.type])}>
        {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}
      </span>
      <span className={code}>{line.code}</span>
    </div>
  );
}

function Half({ line, side }: { line: DiffLine | null; side: 'left' | 'right' }) {
  const tone = line ? line.type : 'none';
  return (
    <div
      data-side={side}
      data-line={line ? line.type : 'none'}
      className={cx(
        'flex min-w-0 flex-[1_1_50%] items-start',
        side === 'right' && 'border-l border-border',
        rowTone[tone],
      )}
      style={line ? undefined : { background: HATCH }}
    >
      <span className={cx(num, numTone[tone])}>{(side === 'left' ? line?.o : line?.n) ?? ''}</span>
      <span className={cx(sign, signTone[tone])}>{line?.type === 'add' ? '+' : line?.type === 'del' ? '−' : ''}</span>
      <span className={code}>{line?.code ?? ''}</span>
    </div>
  );
}

/** The lines of one hunk, unified or split. */
export function HunkLines({ hunk, mode }: { hunk: Parameters<typeof parseHunk>[0]; mode: DiffMode }) {
  const lines = parseHunk(hunk);
  return (
    <div className="pt-1 pb-2">
      {mode === 'unified'
        ? lines.map((l) => <UnifiedRow key={l.i} line={l} />)
        : pairLines(lines).map((r) => (
            <div
              key={`${r.left?.i ?? '-'}:${r.right?.i ?? '-'}`}
              className="flex items-start font-mono text-[12.5px] leading-5 text-diff-text"
            >
              <Half line={r.left} side="left" />
              <Half line={r.right} side="right" />
            </div>
          ))}
    </div>
  );
}
