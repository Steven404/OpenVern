// Redaction for terminal text (docs/terminal-plan.md §2 "Redaction"). Shared by the renderer, which redacts the whole
// emulator buffer before it selects the lines of a read, and the `read_terminal` tool, which redacts again with the
// stored key. Both must look for secrets the same way: if the first pass replaced only the part of a key before an
// invisible character, the second could no longer see a key at all. Pure, no I/O.

import { redactSecrets, SECRET_PATTERNS, sentinel } from './redact';

/**
 * Characters removed from the text, one at a time: the Unicode directional controls (U+061C, U+200E, U+200F,
 * U+202A–U+202E, U+2066–U+2069) and the line and paragraph separators (U+2028, U+2029), which some readers treat as
 * line breaks. C0 controls (other than tab and newline), DEL and C1 controls are listed too, but an answer holding
 * one never gets here: the shared schema refuses it, because escape sequences can't be removed safely (see
 * `TERMINAL_TEXT_FORBIDDEN` in `@shared/api`).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const TEXT_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

/**
 * Plain text for the block, line for line. Only single characters are removed, never a run, so this can never take a
 * character of a key away. No newline is ever added or removed. See `redactTerminalText` for how it combines with redaction.
 */
export function stripTerminalControls(text: string): string {
  return text.replace(TEXT_CONTROL_RE, '');
}

/** Zero-width characters. Kept in the text (emoji sequences need them), but ignored when looking for secrets. */
export const ZERO_WIDTH = '\u200b-\u200d\u2060\ufeff';
const TEXT_INVISIBLE_RE = new RegExp(`${TEXT_CONTROL_RE.source.slice(0, -1)}${ZERO_WIDTH}]`, 'g');

// The vendor patterns without the "not inside a longer word" rule, which `redactIgnoring` applies itself.
const LOOSE_TOKEN_RE = new RegExp(SECRET_PATTERNS.map((p) => `(?:${p.source})`).join('|'), 'g');
const WORD_CHAR_RE = /[A-Za-z0-9_-]/;
/** As in the shared redactor: stored values shorter than this are ignored. */
const MIN_KNOWN_LENGTH = 8;
const STORED_KEY_SENTINEL = sentinel('stored-key');

/**
 * Redacts `text` as if its invisible characters (`invisible`, a global regex of single characters) were not there,
 * and returns it without them. An invisible character inside a key cannot split it, because the search runs on the
 * text without them. One just before a key cannot glue the key to the word in front of it either: the place where a
 * character was removed counts as a word boundary. No order of "remove" and "redact" gives both; this does not depend
 * on an order. Line breaks are kept as `redactSecrets` keeps them.
 */
export function redactIgnoring(
  text: string,
  invisible: RegExp,
  known: readonly string[] | undefined,
): { text: string; count: number } {
  // The text without its invisible characters, and where in it one was removed just before a character.
  let stripped = '';
  const removedBefore = new Set<number>();
  let last = 0;
  for (const match of text.matchAll(invisible)) {
    stripped += text.slice(last, match.index);
    removedBefore.add(stripped.length);
    last = match.index + match[0].length;
  }
  stripped += text.slice(last);

  // Stored keys first, as the shared redactor does: a vendor pattern is greedy, and a token written straight before a
  // stored key (`ghp_…` + `sk-or-…`) would otherwise take the key's first characters into its own match.
  let storedCount = 0;
  for (const value of known ?? []) {
    if (value.length < MIN_KNOWN_LENGTH) continue;
    let rebuilt = '';
    const moved = new Set<number>();
    let start = 0;
    for (let at = stripped.indexOf(value); at !== -1; at = stripped.indexOf(value, start)) {
      for (const pos of removedBefore) if (pos >= start && pos <= at) moved.add(pos - start + rebuilt.length);
      rebuilt += stripped.slice(start, at) + STORED_KEY_SENTINEL;
      start = at + value.length;
      storedCount++;
    }
    if (start === 0) continue;
    for (const pos of removedBefore) if (pos >= start) moved.add(pos - start + rebuilt.length);
    stripped = rebuilt + stripped.slice(start);
    removedBefore.clear();
    for (const pos of moved) removedBefore.add(pos);
  }

  let out = '';
  let count = 0;
  let from = 0;
  LOOSE_TOKEN_RE.lastIndex = 0;
  for (let match = LOOSE_TOKEN_RE.exec(stripped); match; match = LOOSE_TOKEN_RE.exec(stripped)) {
    const at = match.index;
    const atBoundary = at === 0 || removedBefore.has(at) || !WORD_CHAR_RE.test(stripped[at - 1] as string);
    if (!atBoundary) {
      LOOSE_TOKEN_RE.lastIndex = at + 1; // a key may still start further into this word
      continue;
    }
    // Alone, the token starts its string, so the shared redactor accepts it and writes the usual placeholder.
    out += stripped.slice(from, at) + redactSecrets(match[0], { known }).text;
    count++;
    from = at + match[0].length;
  }
  out += stripped.slice(from);

  // Stored keys (exact values), private-key blocks, and nothing new among the tokens already replaced.
  const rest = redactSecrets(out, { known });
  return { text: rest.text, count: storedCount + count + rest.count };
}

/**
 * The text for the block: redacted without regard to its invisible characters, with the directional controls and
 * separators removed. A line that held a secret is shown without any invisible character; every other line keeps its
 * zero-width characters. Line breaks are never added or removed (unless a stored secret holds one, which the caller
 * detects by the line count).
 */
export function redactTerminalText(text: string, known?: readonly string[]): { text: string; count: number } {
  const redacted = redactIgnoring(text, TEXT_INVISIBLE_RE, known);
  if (redacted.count === 0) return { text: stripTerminalControls(text), count: 0 };
  const redactedLines = redacted.text.split('\n');
  const originalLines = text.split('\n');
  if (redactedLines.length !== originalLines.length) return redacted;
  const lines = originalLines.map((line, i) => {
    const bare = line.replace(TEXT_INVISIBLE_RE, '');
    return bare === redactedLines[i] ? stripTerminalControls(line) : (redactedLines[i] as string);
  });
  return { text: lines.join('\n'), count: redacted.count };
}
