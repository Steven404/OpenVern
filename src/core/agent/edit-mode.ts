// Review-mode wording (plan G2.8). Everything the model is told about *proposed* edits lives here, so a later auto
// mode can supply its own text without touching the edit tools or the agent loop.

import { APP_NAME } from '@shared/constants';

/** Names of the tools that stage edits. The agent offers them only when the chat may propose changes. */
export const EDIT_TOOL_NAMES = ['edit_file', 'write_file', 'delete_file'] as const;

export const PROPOSED_NOT_WRITTEN = 'Proposed, not written yet.';

/** Added to `read_file`'s header when the text shown is a proposal, not the file on disk. */
export const PROPOSED_VERSION_NOTE = '(proposed version, not on disk yet)';

/** First line of the next-turn note (plan §4.9). The change service builds the rest. */
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
