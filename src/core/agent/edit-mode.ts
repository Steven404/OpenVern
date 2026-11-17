// Everything the model is told about edits, in both edit modes, lives here: tool descriptions and results, prompt
// lines, refusals and the next-turn note. The edit tools, the agent loop and the change service import it, so the
// wording can change without touching their logic. Review wording is pinned by tests: change it only on purpose.

import { APP_NAME, LIMITS } from '@shared/constants';
import type { ApplyConflictReason, ChangeKind, EditMode, UndoSkipReason } from '@shared/types';

/** Names of the tools that stage edits. The agent offers them only when the chat may propose changes. */
export const EDIT_TOOL_NAMES = ['edit_file', 'write_file', 'delete_file'] as const;

export const PROPOSED_NOT_WRITTEN = 'Proposed, not written yet.';

/** Added to `read_file`'s header when the text shown is a proposal, not the file on disk. */
export const PROPOSED_VERSION_NOTE = '(proposed version, not on disk yet)';

/** First line of the note's review block: what the user did with the proposals since the model's last reply. */
export const CHANGES_NOTE_INTRO = `[${APP_NAME}] Since your last reply the user reviewed your proposed edits:`;

/** Why a read of a proposed-deleted file fails. */
export const PROPOSED_DELETED_NOTE =
  'it is proposed for deletion, but the file stays on disk until the user applies the changes';

/** The text the provider receives for a user message: its own text plus the note about the previous proposals. */
export function withChangesNote(text: string, changesNote: string | undefined): string {
  if (!changesNote) return text;
  return text.length > 0 ? `${text}\n\n${changesNote}` : changesNote;
}

export function editToolDescriptions(): { edit: string; write: string; delete: string } {
  return {
    edit:
      'Propose a change to an existing text file by replacing an exact string. old_string must match the file exactly ' +
      '(whitespace and indentation included) and be unique in the file, unless replace_all is true. Include enough ' +
      'surrounding lines to make it unique. Read the file first. Prefer this over write_file for small and medium changes. ' +
      `The change is only proposed: nothing is written until the user reviews and applies it in ${APP_NAME}. ` +
      'Later reads show your proposed version. The path is relative to the project root.',
    write:
      'Propose creating a new text file, or replacing the whole content of an existing one. Use it for new files, or ' +
      'when most of a file changes; use edit_file for targeted changes. content is the complete file. ' +
      `The change is only proposed: nothing is written until the user reviews and applies it in ${APP_NAME}. ` +
      'Later reads show your proposed version. The path is relative to the project root; missing folders are created on apply.',
    delete:
      'Propose deleting a file. ' +
      `The deletion is only proposed: the file stays on disk until the user reviews and applies it in ${APP_NAME}. ` +
      'The path is relative to the project root.',
  };
}

export function editResultText(input: {
  path: string;
  add: number;
  del: number;
  /** Diff lines, already limited. */
  excerpt: string[];
  /** Diff lines left out of the excerpt. */
  omitted: number;
  /** Number of replacements, when more than one. */
  replacements?: number;
}): string {
  const count = input.replacements && input.replacements > 1 ? ` (${input.replacements} replacements)` : '';
  const out = [`Proposed edit to ${input.path}${count}: +${input.add} -${input.del}`, ...input.excerpt];
  if (input.omitted > 0) out.push(`... ${input.omitted} more diff line(s) not shown`);
  out.push(PROPOSED_NOT_WRITTEN);
  return out.join('\n');
}

export function createResultText(path: string, lines: number): string {
  return `Proposed new file ${path} (${lines} line${lines === 1 ? '' : 's'}). ${PROPOSED_NOT_WRITTEN}`;
}

export function deleteResultText(path: string, lines: number | null): string {
  const size = lines === null ? 'binary file' : `${lines} line${lines === 1 ? '' : 's'}`;
  return `Proposed deleting ${path} (${size}). ${PROPOSED_NOT_WRITTEN}`;
}

export function noChangeText(path: string): string {
  return `No change: ${path} already has this content (nothing was proposed).`;
}

/** Lines of the system prompt that describe the edit tools and the review flow. */
export function editPromptLines(): string[] {
  return [
    'You can propose changes to the project with these tools:',
    '- edit_file: replace an exact string in an existing file. Best for small and medium changes.',
    '- write_file: create a new file, or replace a whole file.',
    '- delete_file: delete a file.',
    '',
    `Edits are proposals. They are not written to disk: the user reviews them in ${APP_NAME} and decides what to apply, hunk by hunk. Your later reads show your proposed versions, so you can edit a file again, or create a file and then edit it.`,
    '- Read a file before you edit it, and copy old_string exactly from what you read.',
    '- Prefer edit_file for small changes; use write_file for new files or rewrites.',
    '- Never say that files were written, saved or changed. Say what you proposed and why.',
    "- Don't paste whole proposed files into your answer: the user sees the diff. Summarise what you proposed and why, in a few lines.",
    '- A user message may end with a note about earlier proposals (applied, rejected or skipped). Trust it over your memory.',
    '- You cannot run commands.',
  ];
}

// ---------------------------------------------------------------------------------------------------- change service

/** `stage` refuses a new file once the pending set holds this many files. */
export function tooManyProposedText(limit: number): string {
  return `Too many proposed files (limit ${limit}). Ask the user to review them first.`;
}

/** `stage` refuses a proposal whose diff the user couldn't review hunk by hunk. */
export function tooLargeToReviewText(path: string): string {
  return (
    `The change to ${path} is too large to review as a diff (over ${LIMITS.diffMaxLinesPerFile.toLocaleString('en-US')} ` +
    'diff lines), so it was not proposed. Split it into smaller edits.'
  );
}

/** Auto: the file's bytes differ from what the tool based its change on, or from what the chat last read. */
export function autoStaleText(path: string): string {
  return (
    `Not written: ${path} changed on disk since you last read it (the user or another chat may have edited it). ` +
    'Read it again, then redo the change.'
  );
}

/** Auto: `write_file` / `delete_file` on an existing file the chat hasn't read. */
export function autoUnreadText(path: string): string {
  return (
    `Not written: read ${path} with read_file first. In Auto, a file must be read in this chat before it is ` +
    'overwritten or deleted.'
  );
}

/** Auto: the path has a Review proposal waiting; writing over it would bypass that review. */
export function autoPendingText(path: string): string {
  return (
    `Not written: ${path} has a proposed edit from an earlier turn waiting for the user's review. Ask the user to ` +
    'apply or discard it first.'
  );
}

/**
 * Auto: the file on disk is over `LIMITS.editSourceMaxBytes`, so it is neither changed nor deleted (Undo would have to
 * keep a copy of it).
 */
export function autoSourceTooLargeText(path: string): string {
  return (
    `Not written: ${path} is larger than ${LIMITS.editSourceMaxBytes / (1024 * 1024)} MB, too large to change or ` +
    'delete with the edit tools. Nothing was changed.'
  );
}

/** Auto: the write itself failed (I/O). Nothing reached the file. */
export function autoWriteFailedText(path: string): string {
  return `Could not write ${path}. Nothing was changed.`;
}

// ---------------------------------------------------------------------------------------------------- next-turn note

/** The note's mode block: the chat's edit mode changed since the model's last reply. */
export function modeChangedNote(mode: EditMode): string {
  return mode === 'auto'
    ? `[${APP_NAME}] Edit mode changed since your last reply: Auto. Your edits are now written to disk as soon as ` +
        'each edit tool call succeeds, and the user can undo a whole turn.'
    : `[${APP_NAME}] Edit mode changed since your last reply: Review. Your edits are proposals again: nothing is ` +
        'written until the user applies them.';
}

/** One proposed file as the note reports it. */
export interface NoteFile {
  path: string;
  kind: ChangeKind;
  accepted: number;
  total: number;
}

/** Every review event since the last note, merged in order. */
export interface ReviewNoteInput {
  written: NoteFile[];
  rejected: NoteFile[];
  discarded: { path: string; kind: ChangeKind }[];
  /** Files with no decision at all. */
  skipped: NoteFile[];
  conflicts: { path: string; reason: ApplyConflictReason }[];
  /** Legacy proposals too large to review, which apply refused to write. */
  tooLarge: string[];
}

const CONFLICT_TEXT: Record<ApplyConflictReason, string> = {
  changed_on_disk: 'changed on disk before apply',
  deleted_on_disk: 'deleted on disk before apply',
  exists_on_disk: 'already exists on disk',
  blocked: 'blocked, the path is not writable',
  too_large: 'too large to review',
};

const notDone: Record<ChangeKind, string> = {
  create: 'new file, not created',
  modify: 'not changed',
  delete: 'not deleted',
};

const writtenText = (f: NoteFile): string => `${f.path} (${f.accepted} of ${f.total}${f.total > 1 ? ' changes' : ''})`;
const notDoneText = (f: { path: string; kind: ChangeKind }): string => `${f.path} (${notDone[f.kind]})`;

/** The note's review block. `stillPending` = files still waiting for review. */
export function reviewNote(input: ReviewNoteInput, stillPending: number): string {
  const lines = [CHANGES_NOTE_INTRO];
  if (input.written.length) lines.push(`- Written: ${input.written.map(writtenText).join(', ')}`);
  if (input.rejected.length) lines.push(`- Rejected: ${input.rejected.map(notDoneText).join(', ')}`);
  if (input.discarded.length) lines.push(`- Discarded: ${input.discarded.map(notDoneText).join(', ')}`);
  if (input.skipped.length) lines.push(`- Left out, not decided: ${input.skipped.map(notDoneText).join(', ')}`);
  for (const c of input.conflicts) lines.push(`- Not written, ${CONFLICT_TEXT[c.reason]}: ${c.path}`);
  for (const path of input.tooLarge) lines.push(`- Not written, too large to review: ${path}`);
  lines.push(
    stillPending > 0
      ? `${stillPending} proposed file${stillPending === 1 ? ' is' : 's are'} still awaiting review. Your reads show your proposed versions.`
      : 'Nothing else is pending.',
  );
  return lines.join('\n');
}

const UNDO_SKIP_TEXT: Record<UndoSkipReason, string> = {
  changed_since: 'changed since',
  blocked: 'blocked',
  unavailable: 'original not available',
};

/** The note's undo block: what the user's Undo clicks since the model's last reply restored and left alone. */
export function undoneNote(
  undos: readonly { restored: readonly string[]; skipped: readonly { path: string; reason: UndoSkipReason }[] }[],
): string {
  const restored = [...new Set(undos.flatMap((u) => u.restored))];
  const lines = [`[${APP_NAME}] Since your last reply the user undid your edits from an earlier turn:`];
  if (restored.length) lines.push(`- Restored to their earlier content: ${restored.join(', ')}`);
  for (const reason of Object.keys(UNDO_SKIP_TEXT) as UndoSkipReason[]) {
    const paths = [...new Set(undos.flatMap((u) => u.skipped.filter((s) => s.reason === reason).map((s) => s.path)))];
    if (paths.length) lines.push(`- Not undone, ${UNDO_SKIP_TEXT[reason]}: ${paths.join(', ')}`);
  }
  return lines.join('\n');
}
