// The "Proposed edits" / "Edits applied" card under an assistant turn (plan §5.2, G5.1).

import { cx } from '@renderer/components/ui';
import { useUiStore } from '@renderer/stores/ui';
import type { AppliedBatch, PendingChanges } from '@shared/types';
import { Check } from 'lucide-react';
import { DiffIcon } from '../right-panel/icons';
import { openPanelSurface, useChatPanelState } from '../right-panel/panel-store';
import { appliedLabel, plural, progressLabel, progressOf } from './diff';
import { PathLabel, StatusBadge, Totals } from './parts';
import { useDecisions } from './review-store';

/** The Diff surface is the visible panel content. */
function useReviewing(chatId: string): boolean {
  const open = useUiStore((s) => s.rightPanelOpen);
  const state = useChatPanelState(chatId);
  return open && state.active?.type === 'surface' && state.active.id === 'diff';
}

function CardShell({
  title,
  fileCount,
  add,
  del,
  highlight,
  rows,
  footer,
}: {
  title: string;
  fileCount: number;
  add: number;
  del: number;
  highlight: boolean;
  rows: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      data-testid="changes-card"
      className={cx('overflow-hidden rounded-[12px]', highlight ? 'bg-card-active' : 'bg-card')}
    >
      <div className="flex flex-wrap items-center gap-2.5 pt-3 pr-3.5 pb-2.5 pl-4">
        <DiffIcon size={17} className="text-accent" />
        <span className="text-[14px] font-semibold text-text">{title}</span>
        <span className="text-[13px] text-text-muted">{plural(fileCount, 'file')}</span>
        <span className="flex-1" />
        <Totals add={add} del={del} />
      </div>
      <ul className="m-0 flex list-none flex-col gap-px px-2 pb-2">{rows}</ul>
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
  return (
    <CardShell
      title="Edits applied"
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
          onOpen={() => openPanelSurface(chatId, 'diff', { path: f.path })}
        />
      ))}
      footer={
        <>
          <Check aria-hidden="true" size={15} strokeWidth={2.2} className="flex-none text-success" />
          <span className="min-w-0 flex-1 text-[13px] text-text-secondary">{appliedLabel(batch)}</span>
        </>
      }
    />
  );
}
