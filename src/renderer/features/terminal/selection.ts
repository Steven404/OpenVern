// "Add selection to chat" (terminal plan T3.5): the selected terminal text as a fenced `text` block for the composer.
// Every secret-looking value is redacted with the same pattern passes the tool path uses, because whatever lands in the
// composer goes to the model. The cap is applied only after redaction: cutting first can strip a key's prefix and leave
// its body unmatched, so the body would reach the model unredacted.

import { TERMINAL } from '@shared/terminal';
import { redactTerminalText } from '@shared/terminal-redact';
import { redactBufferLines } from './redact-buffer';

/** A backtick fence longer than any run of backticks in `text`, so output that shows a fence does not end ours. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The block the dock inserts into the chat's composer, or `null` when the selection is blank. Line endings are
 * normalised, trailing spaces dropped, secrets redacted, and only then is the text capped; a cut selection comes with a
 * line saying so after the fence.
 */
export function terminalSelectionBlock(selection: string): string | null {
  const lines = selection
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  const trimmed = lines.join('\n').trim();
  if (trimmed === '') return null;

  const selectedLines = trimmed.split('\n');
  const { text: redacted } = redactTerminalText(
    redactBufferLines(
      selectedLines,
      selectedLines.map(() => true),
    ).join('\n'),
  );
  // Cut by code point, so a surrogate pair at the boundary is kept whole.
  const points = Array.from(redacted);
  const truncated = points.length > TERMINAL.selectionMaxChars;
  const capped = truncated ? points.slice(0, TERMINAL.selectionMaxChars).join('') : redacted;

  const fence = fenceFor(capped);
  const block = [`${fence}text`, capped, fence].join('\n');
  return truncated ? `${block}\n[The selection was cut at ${TERMINAL.selectionMaxChars} characters.]` : block;
}
