// The "Proposed edits" / "Edits applied" card under an assistant turn, and its Auto variant ("Edits applied · Auto").

import { cx } from '@renderer/components/ui';
import { useUiStore } from '@renderer/stores/ui';
import type { AppliedBatch, PendingChanges } from '@shared/types';
import { Check } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { DiffIcon } from '../right-panel/icons';
import { openPanelSurface, useChatPanelState } from '../right-panel/panel-store';
import { appliedLabel, autoUndoState, plural, progressLabel, progressOf } from './diff';
import { cardRows } from './list-split';
import { PathLabel, StatusBadge, Totals } from './parts';
import { useDecisions } from './review-store';
import { UndoControl } from './UndoDialog';

/** The Diff surface is the visible panel content. */
function useReviewing(chatId: string): boolean {
  const open = useUiStore((s) => s.rightPanelOpen);
  const state = useChatPanelState(chatId);
  return open && state.active?.type === 'surface' && state.active.id === 'diff';
}

function CardShell({
  title,
  badge,
  testId = 'changes-card',
  dataAttrs,
  fileCount,
  add,
  del,
  highlight,
  rows,
  footer,
}: {
  title: string;
  /** Small label after the title, e.g. "Auto". Part of the card's accessible name. */
  badge?: string;
  testId?: string;
  dataAttrs?: Record<`data-${string}`, string>;
  fileCount: number;
  add: number;
  del: number;
  highlight: boolean;
  rows: ReactNode[];
  footer: ReactNode;
}) {
  // Long lists show a preview; the toggle is local to this card and not persisted. The toggle follows the count, so
  // a card that expanded and then shrank does not keep a stale "Show fewer".
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const { shown, collapsible } = cardRows(rows.length, expanded);
  return (
    <section
      aria-label={badge ? `${title} · ${badge}` : title}
      data-testid={testId}
      {...dataAttrs}
      className={cx('overflow-hidden rounded-[12px]', highlight ? 'bg-card-active' : 'bg-card')}
    >
      <div className="flex flex-wrap items-center gap-2.5 pt-3 pr-3.5 pb-2.5 pl-4">
        <DiffIcon size={17} className="text-accent" />
        <span className="text-[14px] font-semibold text-text">{title}</span>
        {badge && <span className="text-[12px] font-medium text-accent-2">{badge}</span>}
        <span className="text-[13px] text-text-muted">{plural(fileCount, 'file')}</span>
        <span className="flex-1" />
        <Totals add={add} del={del} />
      </div>
      <ul id={listId} className={cx('m-0 flex list-none flex-col gap-px px-2', !collapsible && 'pb-2')}>
        {rows.slice(0, shown)}
      </ul>
      {collapsible ? (
        <div className="px-2 pt-0.5 pb-2">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex min-h-[30px] w-full cursor-pointer items-center justify-start rounded-[6px] border-0 bg-transparent px-2 text-[12.5px] text-text-muted hover:bg-overlay-row hover:text-text"
          >
            {expanded ? 'Show fewer' : `Show all ${rows.length} files`}
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2.5 border-t border-border bg-[#111630] py-2.5 pr-3 pl-4">
        {footer}
      </div>
    </section>
  );
}

function FileRow({
  path,
  kind,
  add,
  del,
  onOpen,
}: {
  path: string;
  kind: 'create' | 'modify' | 'delete';
  add: number;
  del: number;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-[34px] w-full cursor-pointer items-center gap-2.5 rounded-[6px] border-0 bg-transparent px-2 text-left text-[13px] text-text-secondary hover:bg-overlay-row"
      >
        <StatusBadge kind={kind} />
        <PathLabel path={path} />
        <Totals add={add} del={del} small />
      </button>
    </li>
  );
}

export function ProposedEditsCard({ chatId, pending }: { chatId: string; pending: PendingChanges }) {
  const decisions = useDecisions(chatId, pending);
  const reviewing = useReviewing(chatId);
  const progress = progressOf(pending.files, decisions);
  const toggle = () => {
    if (reviewing) useUiStore.getState().setRightPanelOpen(false);
    else openPanelSurface(chatId, 'diff', {});
  };
  return (
    <CardShell
      title="Proposed edits"
      fileCount={pending.files.length}
      add={pending.totalAdd}
      del={pending.totalDel}
      highlight={reviewing}
      rows={pending.files.map((f) => (
        <FileRow
          key={f.path}
          path={f.path}
          kind={f.kind}
          add={f.add}
          del={f.del}
          onOpen={() => openPanelSurface(chatId, 'diff', { path: f.path })}
        />
      ))}
      footer={
        <>
          <span aria-hidden="true" className="size-[7px] flex-none rounded-full bg-accent" />
          <span className="min-w-0 flex-1 text-[13px] text-text-secondary">
            Nothing is written until you apply. <span className="text-text-muted">{progressLabel(progress)}</span>
          </span>
          <button
            type="button"
            aria-pressed={reviewing}
            onClick={toggle}
            className={cx(
              'inline-flex min-h-[34px] cursor-pointer items-center gap-2 rounded-[8px] border-0 px-3 text-[13px] font-medium text-text hover:bg-overlay-tonal-hover',
              'bg-overlay-tonal aria-pressed:bg-overlay-tonal-active',
            )}
          >
            {reviewing ? 'Reviewing' : 'Review changes'}
            <DiffIcon size={14} />
          </button>
        </>
      }
    />
  );
}

export function AppliedEditsCard({ chatId, batch }: { chatId: string; batch: AppliedBatch }) {
  const add = batch.written.reduce((n, f) => n + f.add, 0);
  const del = batch.written.reduce((n, f) => n + f.del, 0);
  const auto = batch.source === 'auto';
  return (
    <CardShell
      title="Edits applied"
      badge={auto ? 'Auto' : undefined}
      testId={auto ? 'auto-edits-card' : undefined}
      dataAttrs={auto ? { 'data-undo': autoUndoState(batch), 'data-batch-id': batch.id } : undefined}
      fileCount={batch.written.length}
      add={add}
      del={del}
      highlight={false}
      rows={batch.written.map((f) => (
        <FileRow
          key={f.path}
          path={f.path}
          kind={f.kind}
          add={f.add}
          del={f.del}
          // The file belongs to this batch, not to the pending proposals: the Diff panel scrolls its History to the
          // batch and opens the file there.
          onOpen={() => openPanelSurface(chatId, 'diff', { batchId: batch.id, path: f.path })}
        />
      ))}
      footer={
        auto ? (
          <UndoControl chatId={chatId} batch={batch} variant="card" />
        ) : (
          <>
            <Check aria-hidden="true" size={15} strokeWidth={2.2} className="flex-none text-success" />
            <span className="min-w-0 flex-1 text-[13px] text-text-secondary">{appliedLabel(batch)}</span>
          </>
        )
      }
    />
  );
}
