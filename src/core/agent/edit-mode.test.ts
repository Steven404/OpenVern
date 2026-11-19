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
  it('writes each conflict line exactly as v0.3 did, also for a path holding a line break', () => {
    // v0.3's formatter, verbatim: "path (reason)" rewritten by a regex that can't match across a line terminator.
    const v03Text = {
      changed_on_disk: 'changed on disk before apply',
      deleted_on_disk: 'deleted on disk before apply',
      exists_on_disk: 'already exists on disk',
      blocked: 'blocked, the path is not writable',
    } as const;
    const v03Line = (c: string) => `- Not written, ${c.replace(/^(.*) \((.*)\)$/, '$2: $1')}`;
    const note = (path: string, reason: keyof typeof v03Text) =>
      w.reviewNote(
        { written: [], rejected: [], discarded: [], skipped: [], conflicts: [{ path, reason }], tooLarge: [] },
        0,
      );
    expect(note('alpha\nbeta.txt', 'changed_on_disk')).toBe(
      [
        '[OpenVern] Since your last reply the user reviewed your proposed edits:',
        '- Not written, alpha\nbeta.txt (changed on disk before apply)',
        'Nothing else is pending.',
      ].join('\n'),
    );
    const paths = [
      'alpha\nbeta.txt',
      'a\rb',
      'a\u2028b',
      'a\u2029b',
      'trailing\n',
      '\nlead',
      'a (b).txt',
      'x (y)',
      'plain.ts',
      'dir/with space (1)/f.ts',
      '$1 $2 $&.txt',
    ];
    for (const path of paths) {
      for (const reason of Object.keys(v03Text) as (keyof typeof v03Text)[]) {
        expect(note(path, reason).split('\n').slice(1, -1).join('\n')).toBe(v03Line(`${path} (${v03Text[reason]})`));
      }
    }
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

describe('a retried turn’s mode line', () => {
  const auto = w.modeChangedNote('auto');
  const review = w.modeChangedNote('review');
  const rest = '[OpenVern] Since your last reply the user undid your edits from an earlier turn:';
  it.each([
    ['no note, mode changed since', undefined, { mode: 'auto', lastMode: 'review' }, auto],
    ['no note, same mode', undefined, { mode: 'review', lastMode: 'review' }, undefined],
    ['line only, retried in the mode before the turn', auto, { mode: 'review', lastMode: 'auto' }, undefined],
    ['line only, retried in the announced mode', auto, { mode: 'auto', lastMode: 'auto' }, auto],
    [
      'line + rest, retried in the mode before the turn',
      `${review}\n\n${rest}`,
      { mode: 'auto', lastMode: 'review' },
      rest,
    ],
    [
      'line + rest, retried in the announced mode',
      `${auto}\n\n${rest}`,
      { mode: 'auto', lastMode: 'auto' },
      `${auto}\n\n${rest}`,
    ],
    ['rest only, mode changed since', rest, { mode: 'auto', lastMode: 'review' }, `${auto}\n\n${rest}`],
    ['rest only, same mode', rest, { mode: 'review', lastMode: 'review' }, rest],
  ] as const)('%s', (_, note, o, expected) => {
    expect(w.withModeLine(note, { ...o, firstTurn: false })).toBe(expected);
  });
  it('the first turn never gets a line, and loses a stale one', () => {
    expect(w.withModeLine(undefined, { mode: 'auto', lastMode: 'review', firstTurn: true })).toBeUndefined();
    expect(w.withModeLine(`${auto}\n\n${rest}`, { mode: 'review', lastMode: 'review', firstTurn: true })).toBe(rest);
  });
});

describe('diagnostics shared by the change service and the edit tools', () => {
  it('keep their wording', () => {
    expect(w.newContentTooLargeText('a.ts')).toBe('The new content of a.ts is over 256 KB.');
    expect(w.notUtf8Text('a.ts')).toBe('a.ts: only UTF-8 text can be written.');
    expect(w.placeholderContentText('a.ts')).toBe(
      'The content for a.ts contains a «redacted:…» placeholder. Writing it back would destroy the real secret; use edit_file around it instead.',
    );
    expect(w.binaryTargetText('a.ts')).toBe("a.ts is a binary file; it can't be edited or overwritten.");
    expect(w.binaryFileText('a.ts')).toBe(
      'a.ts is a binary file (or not valid UTF-8) and cannot be edited or overwritten.',
    );
  });
  it('pin the final-bytes limit and the unsaved-history line', () => {
    expect(w.writtenTooLargeText('auto', 'a.ts', 266600)).toBe(
      'a.ts would be 260 KB on disk (its CRLF line endings are kept), over the 256 KB limit for a write.',
    );
    expect(w.writtenTooLargeText('review', 'a.ts', 266600)).toBe(
      'a.ts would be 260 KB on disk (its CRLF line endings are kept), over the 256 KB limit for a proposal.',
    );
    expect(w.autoUnsavedText()).toBe(
      "OpenVern couldn't save this edit to the chat's change history yet. It is on disk, and Undo covers it only while the app stays open.",
    );
  });
});
