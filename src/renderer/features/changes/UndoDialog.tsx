// Undo for an auto batch: the button, its confirm dialog and the batch's undo status. Shared by the Edits applied ·
// Auto card and the Diff panel's History, which both read the chat's changes query, so an undo from either updates
// both.

import { Button, cx, Dialog, DialogContent } from '@renderer/components/ui';
import { ApiError } from '@renderer/lib/api-client';
import { useApiClient } from '@renderer/lib/api-context';
import { queryKeys } from '@renderer/lib/query-keys';
import { useRunsStore } from '@renderer/stores/runs';
import type { AppliedBatch, Id } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Undo2 } from 'lucide-react';
import { type RefObject, useRef, useState } from 'react';
import { autoUndoState, plural, undoneLabel, undoSkipLabel } from './diff';

const RUNNING_TITLE = 'Wait for the reply to finish';

/** A run is open or settling: the server refuses an undo then, so the button waits. */
function useChatBusy(chatId: Id): boolean {
  return useRunsStore((s) => {
    const st = s.runs[chatId]?.status;
    return st === 'running' || st === 'settling';
  });
}

export interface UndoControlProps {
  chatId: Id;
  /** An auto batch (`source: 'auto'`). */
  batch: AppliedBatch;
  /** `card`: the card's footer line. `history`: compact, in a History entry's header. */
  variant: 'card' | 'history';
}

/**
 * The batch's Undo button (with its dialog) while it can be undone, otherwise its undo status. The dialog stays
 * mounted across that switch, so closing it after a successful undo can still move focus: back to the button while it
 * exists, else to the status line that replaced it.
 */
export function UndoControl({ chatId, batch, variant }: UndoControlProps) {
  const busy = useChatBusy(chatId);
  const [open, setOpen] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Only a mounting element takes over: the button unmounting must not clear the status line that replaces it.
  const keepForFocus = (el: HTMLElement | null) => {
    if (el) returnFocusRef.current = el;
  };
  const state = autoUndoState(batch);
  const compact = variant === 'history';

  return (
    <>
      {state === 'undoable' ? (
        <>
          {!compact && (
            <span className="flex min-w-0 flex-1 items-center gap-2.5 text-[13px] text-text-secondary">
              <Check aria-hidden="true" size={15} strokeWidth={2.2} className="flex-none text-success" />
              Written as the model worked
            </span>
          )}
          <Button
            ref={keepForFocus}
            variant="ghost"
            size="sm"
            data-testid="undo-button"
            aria-label="Undo the edits from this turn"
            title={busy ? RUNNING_TITLE : undefined}
            disabled={busy}
            onClick={() => setOpen(true)}
            className={cx(compact && 'min-h-7 px-2 text-[12.5px]')}
          >
            <Undo2 aria-hidden="true" size={14} strokeWidth={2} />
            Undo
          </Button>
        </>
      ) : (
        <UndoStatus batch={batch} compact={compact} statusRef={keepForFocus} />
      )}
      <UndoDialog
        open={open}
        onOpenChange={setOpen}
        chatId={chatId}
        batch={batch}
        busy={busy}
        returnFocusRef={returnFocusRef}
      />
    </>
  );
}

/** "Undone · N files restored" / "Undone by a retry" plus what was left alone, or "Undo no longer available". */
function UndoStatus({
  batch,
  compact,
  statusRef,
}: {
  batch: AppliedBatch;
  compact: boolean;
  statusRef: (el: HTMLElement | null) => void;
}) {
  const undo = batch.undo;
  if (!undo) {
    return (
      <span
        ref={statusRef}
        tabIndex={-1}
        data-testid="undo-status"
        data-state="unavailable"
        className={cx('min-w-0 text-text-faint outline-none', compact ? 'text-[12px]' : 'flex-1 text-[13px]')}
      >
        Undo no longer available
      </span>
    );
  }
  return (
    <span
      ref={statusRef}
      tabIndex={-1}
      data-testid="undo-status"
      data-state="undone"
      data-by={undo.by}
      className={cx('flex min-w-0 flex-col gap-0.5 outline-none', !compact && 'flex-1')}
    >
      <span
        className={cx(
          'flex items-center gap-2 text-text-secondary',
          compact ? 'text-[12px] text-text-muted' : 'text-[13px]',
        )}
      >
        {!compact && <Undo2 aria-hidden="true" size={15} strokeWidth={2} className="flex-none text-text-muted" />}
        {undoneLabel(undo)}
      </span>
      {/* In the History the skipped files are listed under the entry's files instead (see AppliedList). */}
      {!compact && undo.skipped.length > 0 && <UndoSkippedList skipped={undo.skipped} />}
    </span>
  );
}

/** The files an undo left alone, in the danger tone. */
export function UndoSkippedList({
  skipped,
  className,
}: {
  skipped: NonNullable<AppliedBatch['undo']>['skipped'];
  className?: string;
}) {
  return (
    <ul data-testid="undo-skipped" className={cx('m-0 flex list-none flex-col gap-0.5 p-0', className)}>
      {skipped.map((s) => (
        <li key={s.path} className="min-w-0 truncate text-[12.5px] text-danger" title={s.path}>
          {undoSkipLabel(s)}
        </li>
      ))}
    </ul>
  );
}

function UndoDialog({
  open,
  onOpenChange,
  chatId,
  batch,
  busy,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: Id;
  batch: AppliedBatch;
  busy: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const undo = useMutation({
    mutationFn: () => api.undoChatBatch(chatId, batch.id),
    onSuccess: (res) => {
      queryClient.setQueryData(queryKeys.chatChanges(chatId), res.changes);
      onOpenChange(false);
    },
    onError: (err) => {
      // A refusal (the batch was undone elsewhere, aged out, or the chat started a run) means the cached state is
      // behind: refetch, so the card and the History show where the batch really stands.
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.chatChanges(chatId) });
      }
    },
  });
  const change = (next: boolean) => {
    if (undo.isPending) return;
    if (!next) undo.reset();
    onOpenChange(next);
  };
  const paths = batch.written.map((f) => f.path);
  const error = undo.error
    ? undo.error instanceof ApiError
      ? undo.error.info.message
      : "Couldn't undo the edits. Try again."
    : null;

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        title="Undo this turn's edits?"
        description={`OpenVern puts ${paths.length === 1 ? 'this file' : `these ${plural(paths.length, 'file')}`} back as ${paths.length === 1 ? 'it was' : 'they were'} before this turn:`}
        width={480}
        returnFocusRef={returnFocusRef}
        data-testid="undo-dialog"
        footer={
          <>
            <Button variant="ghost" data-testid="undo-cancel" disabled={undo.isPending} onClick={() => change(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="undo-confirm"
              loading={undo.isPending}
              disabled={busy}
              title={busy ? RUNNING_TITLE : undefined}
              onClick={() => undo.mutate()}
            >
              Undo edits
            </Button>
          </>
        }
      >
        <ul className="m-0 flex max-h-[240px] list-none flex-col gap-1 overflow-y-auto rounded-[8px] bg-code p-3">
          {paths.map((p) => (
            <li key={p} className="min-w-0 truncate font-mono text-[12.5px] text-text-secondary" title={p}>
              {p}
            </li>
          ))}
        </ul>
        <p className="m-0 text-sm text-text-muted">A file that changed after the turn is left as it is.</p>
        {error && (
          <p role="alert" data-testid="undo-error" className="m-0 text-sm text-danger">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
