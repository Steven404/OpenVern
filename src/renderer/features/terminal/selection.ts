// "Add selection to chat" (terminal plan T3.5): the selected terminal text as a fenced `text` block for the composer.
// The selection is capped at `selectionMaxChars` and every secret-looking value is redacted with the same pattern
// passes the tool path uses, because whatever lands in the composer goes to the model.

import { redactSecrets } from '@shared/redact';
import { TERMINAL } from '@shared/terminal';

/** A backtick fence longer than any run of backticks in `text`, so output that shows a fence does not end ours. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The block the dock inserts into the chat's composer, or `null` when the selection is blank. Line endings are
 * normalised, trailing spaces dropped, and a cut selection comes with a line saying so after the fence.
 */
export function terminalSelectionBlock(selection: string): string | null {
  const lines = selection
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  const trimmed = lines.join('\n').trim();
  if (trimmed === '') return null;

  const truncated = trimmed.length > TERMINAL.selectionMaxChars;
  const capped = truncated ? trimmed.slice(0, TERMINAL.selectionMaxChars) : trimmed;
  const { text } = redactSecrets(capped);

  const fence = fenceFor(text);
  const block = [`${fence}text`, text, fence].join('\n');
  return truncated ? `${block}\n[The selection was cut at ${TERMINAL.selectionMaxChars} characters.]` : block;
}
