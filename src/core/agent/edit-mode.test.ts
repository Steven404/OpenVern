import { describe, expect, it } from 'vitest';
import * as w from './edit-mode';

const diff = { path: 'a.ts', add: 2, del: 1, excerpt: ['-old', '+new'], omitted: 3, replacements: 2 };

describe('edit wording contracts', () => {
  it.each(['auto', 'review'] as const)('pins every %s tool description', (mode) => {
    expect(w.editToolDescriptions(mode)).toMatchSnapshot();
  });
  it.each(['auto', 'review'] as const)('pins every %s system prompt line', (mode) => {
    expect(w.editPromptLines(mode)).toMatchSnapshot();
  });
  it('pins Auto result text including large diffs, replacements, singular, plural and binary', () => {
    expect([
      w.writtenEditText(diff),
      w.writtenEditText({ ...diff, tooLarge: true }),
      w.writtenEditText({ ...diff, replacements: 1, omitted: 0 }),
      w.createdText('a.ts', 1),
      w.createdText('a.ts', 2),
      w.deletedText('a.ts', 1),
      w.deletedText('a.ts', 2),
      w.deletedText('a.ts', null),
      w.autoNoChangeText('a.ts'),
      w.editNoChangeText('auto', 'a.ts'),
      w.writeNoChangeText('auto', 'a.ts'),
      w.changeFailedText('auto', 'a.ts'),
      w.editedTooLargeText('auto', 300000),
      w.contentTooLargeText('auto', 300000),
      w.sourceTooLargeText('auto', 'a.ts', 6000000),
      w.autoStaleText('a.ts'),
      w.autoUnreadText('a.ts'),
      w.autoPendingText('a.ts'),
    ]).toMatchSnapshot();
  });
  it('pins the stage refusal while proposals for another project are pending', () => {
    expect(w.OTHER_PROJECT_PENDING_TEXT).toBe(
      "Not proposed: this chat has proposed edits for another project waiting for the user's review. Ask the user to discard them first.",
    );
  });
  it('preserves the Review result and note wording', () => {
    expect([
      w.editResultText(diff),
      w.createResultText('a.ts', 1),
      w.createResultText('a.ts', 2),
      w.deleteResultText('a.ts', null),
      w.deleteResultText('a.ts', 2),
      w.noChangeText('a.ts'),
      w.editNoChangeText('review', 'a.ts'),
      w.writeNoChangeText('review', 'a.ts'),
      w.changeFailedText('review', 'a.ts'),
      w.proposedForDeletionText('a.ts'),
      w.alreadyProposedForDeletionText('a.ts'),
      w.editedTooLargeText('review', 300000),
      w.contentTooLargeText('review', 300000),
      w.sourceTooLargeText('review', 'a.ts', 6000000),
      w.PROPOSED_NOT_WRITTEN,
      w.PROPOSED_VERSION_NOTE,
      w.PROPOSED_DELETED_NOTE,
      w.EDITING_UNAVAILABLE_TEXT,
      w.reviewNote(
        {
          written: [{ path: 'a.ts', kind: 'modify', accepted: 1, total: 2 }],
          rejected: [{ path: 'b', kind: 'delete', accepted: 0, total: 1 }],
          discarded: [{ path: 'c', kind: 'create' }],
          skipped: [{ path: 'd', kind: 'modify', accepted: 0, total: 1 }],
          conflicts: [{ path: 'e', reason: 'changed_on_disk' }],
          tooLarge: [],
        },
        2,
      ),
    ]).toMatchSnapshot();
  });
  it.each(['changed_since', 'blocked', 'unavailable'] as const)('pins retry note and notice for %s', (reason) => {
    const undo = { restored: ['a.ts'], skipped: [{ path: 'c.ts', reason }] };
    expect([
      w.retryUndoNote(undo),
      w.retryUndoNotice(undo),
      w.retryUndoNotice({ ...undo, restored: [] }),
    ]).toMatchSnapshot();
  });
  it('pins retry plural and empty notices', () => {
    const undo = {
      restored: ['a', 'b'],
      skipped: [
        { path: 'c', reason: 'changed_since' as const },
        { path: 'd', reason: 'changed_since' as const },
        { path: 'e', reason: 'blocked' as const },
        { path: 'f', reason: 'unavailable' as const },
      ],
    };
    expect([
      w.retryUndoNote(undo),
      w.retryUndoNotice(undo),
      w.retryUndoNotice({ restored: [], skipped: [] }),
      w.retryUndoNotice({ restored: ['a'], skipped: [] }),
    ]).toMatchSnapshot();
  });
});
