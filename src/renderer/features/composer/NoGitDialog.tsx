import { LIMITS } from '@shared/constants';
import type { RefObject } from 'react';
import { Button, Dialog, DialogContent } from '../../components/ui';

export interface NoGitDialogProps {
  open: boolean;
  /** Closing without a choice (Escape, the overlay) changes nothing. */
  onOpenChange: (open: boolean) => void;
  projectName: string;
  /**
   * `turn-on`: Auto is being chosen for a chat in this project. `move`: a chat already in Auto is being moved into it.
   */
  reason: 'turn-on' | 'move';
  returnFocusRef: RefObject<HTMLElement | null>;
  /** The ghost choice: the chat stays in (or moves in) Review. */
  onReview: () => void;
  /** The primary choice: the chat runs in Auto in this project. The caller records the acknowledgment. */
  onAuto: () => void;
}

const COPY = {
  'turn-on': {
    title: 'Turn on Auto for a folder without Git?',
    lead: "In Auto, the model's edits are written to your files as it works.",
    review: 'Keep Review',
    auto: 'Turn on Auto',
  },
  move: {
    title: 'Move this Auto chat to a folder without Git?',
    lead: "This chat is in Auto, so the model's edits are written to your files as it works.",
    review: 'Switch to Review',
    auto: 'Keep Auto',
  },
} as const;

/**
 * Asked before a chat runs in Auto in a project whose folder isn't in a Git work tree, once per project on this
 * device: beyond the app's own per-turn Undo there is no history to go back to.
 */
export function NoGitDialog({
  open,
  onOpenChange,
  projectName,
  reason,
  returnFocusRef,
  onReview,
  onAuto,
}: NoGitDialogProps) {
  const copy = COPY[reason];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={copy.title}
        description={
          <>
            {projectName} isn't a Git repository. {copy.lead} OpenVern can undo each of the last {LIMITS.autoUndoTurns}{' '}
            turns in this chat, but there is no other history to go back to.
          </>
        }
        width={460}
        returnFocusRef={returnFocusRef}
        data-testid="no-git-dialog"
        data-reason={reason}
        footer={
          <>
            <Button variant="ghost" data-testid="no-git-keep-review" onClick={onReview}>
              {copy.review}
            </Button>
            <Button variant="primary" data-testid="no-git-turn-on-auto" onClick={onAuto}>
              {copy.auto}
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
