import { LIMITS } from '@shared/constants';
import type { RefObject } from 'react';
import { Button, Dialog, DialogContent } from '../../components/ui';

export interface NoGitDialogProps {
  open: boolean;
  /** Closing without a choice (Escape, the overlay) changes nothing. */
  onOpenChange: (open: boolean) => void;
  projectName: string;
  /**
   * `turn-on`: Auto is being chosen for a chat in this project, whose folder isn't in Git. `move`: a chat already in
   * Auto is being moved into it. `move-hidden`: a chat in Auto whose Review / Auto chip isn't on screen (no project, no
   * key, a model without tools) is being moved into this project, whose folder is in Git (or was already accepted
   * without it); the user hasn't been shown the mode, so it says so before the chat can write there.
   */
  reason: 'turn-on' | 'move' | 'move-hidden';
  returnFocusRef: RefObject<HTMLElement | null>;
  /** The ghost choice: the chat stays in (or moves in) Review. */
  onReview: () => void;
  /** The primary choice: the chat runs in Auto in this project. The caller records the no-Git acknowledgment. */
  onAuto: () => void;
}

const NO_GIT_HISTORY = `OpenVern can undo each of the last ${LIMITS.autoUndoTurns} sets of edits in this chat, but there is no other history to go back to.`;

const COPY = {
  'turn-on': {
    title: 'Turn on Auto for a folder without Git?',
    body: (project: string) =>
      `${project} isn't a Git repository. In Auto, the model's edits are written to your files as it works. ${NO_GIT_HISTORY}`,
    review: 'Keep Review',
    auto: 'Turn on Auto',
  },
  // Also covers an Auto chat whose chip is hidden: it says the chat is in Auto, so one dialog asks both questions.
  move: {
    title: 'Move this Auto chat to a folder without Git?',
    body: (project: string) =>
      `${project} isn't a Git repository. This chat is in Auto, so the model's edits are written to your files as it works. ${NO_GIT_HISTORY}`,
    review: 'Switch to Review',
    auto: 'Keep Auto',
  },
  'move-hidden': {
    title: 'Keep this chat in Auto?',
    body: (project: string) =>
      `This chat is in Auto. After the move to ${project}, the model's edits are written to your files as it works. OpenVern can undo each of the last ${LIMITS.autoUndoTurns} sets of edits in this chat.`,
    review: 'Switch to Review',
    auto: 'Keep Auto',
  },
} as const;

/**
 * Asked before a chat runs in Auto in a project without the user having been shown that: a folder that isn't in a
 * Git work tree (once per project on this device, since beyond the app's own per-turn Undo there is no history to go
 * back to), or a move of a chat whose Auto isn't on screen.
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
        description={copy.body(projectName)}
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
