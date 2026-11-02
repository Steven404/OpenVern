// Line-based diffing and hunk application for change sets (v0.2 plan G1.4, G1.5).
//
// Text is handled as lines: line endings (CRLF vs LF) and the final-newline state never show up in a diff, and writing
// a file back keeps the original ones. Unchanged lines are copied byte for byte from the base.

import { createHash } from 'node:crypto';
import { LIMITS } from '@shared/constants';
import type { ChangeKind, DiffHunk, FileChange } from '@shared/types';
import { structuredPatch } from 'diff';

/** Splits text into raw segments, each keeping its own line terminator. `''` has no lines. */
export function rawSegments(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

const lineText = (segment: string): string => segment.replace(/\r?\n$/, '');

/** The lines of `text` without terminators. */
export function toLines(text: string): string[] {
  return rawSegments(text).map(lineText);
}

export function sameLines(a: string, b: string): boolean {
  const x = toLines(a);
  const y = toLines(b);
  return x.length === y.length && x.every((line, i) => line === y[i]);
}

/** The line ending a file uses: CRLF as soon as it has one, else LF. */
export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

const joinForDiff = (lines: string[]): string => lines.map((l) => `${l}\n`).join('');

const DECLARATION =
  /^\s{0,2}(?:export\s+|pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|default\s+|abstract\s+)*(?:function\*?|class|interface|type|enum|namespace|const|let|var|def|fn|func|struct|impl|trait|mod)\b/;

/** Nearest declaration-looking line above `beforeIndex` (0-based, exclusive). Best effort, '' when none. */
function findHeader(baseLines: string[], beforeIndex: number): string {
  for (let i = Math.min(beforeIndex, baseLines.length) - 1; i >= 0; i--) {
    const line = baseLines[i] as string;
    if (DECLARATION.test(line)) return line.trim().slice(0, 100);
  }
  return '';
}

function hunkId(oldStart: number, lines: string[]): string {
  return `${oldStart}:${createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 8)}`;
}

const count = (hunks: DiffHunk[], sign: '+' | '-'): number =>
  hunks.reduce((n, h) => n + h.lines.filter((l) => l[0] === sign).length, 0);

/** Totals and the `tooLarge` cut-off for a file's hunks. */
export function finishFileChange(path: string, kind: ChangeKind, hunks: DiffHunk[]): FileChange {
  const add = count(hunks, '+');
  const del = count(hunks, '-');
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  if (total > LIMITS.diffMaxLinesPerFile) return { path, kind, add, del, hunks: [], tooLarge: true };
  return { path, kind, add, del, hunks };
}

/** Diff of one file. `base` / `content` are null for a created / deleted file. */
export function diffFile(path: string, base: string | null, content: string | null): FileChange {
  const kind: ChangeKind = base === null ? 'create' : content === null ? 'delete' : 'modify';
  const baseLines = toLines(base ?? '');
  const newLines = toLines(content ?? '');
  const patch = structuredPatch(path, path, joinForDiff(baseLines), joinForDiff(newLines), '', '', { context: 3 });

  const hunks: DiffHunk[] = patch.hunks.map((h) => {
    const oldStart = h.oldLines === 0 ? 0 : h.oldStart;
    return {
      id: hunkId(oldStart, h.lines),
      oldStart,
      oldLines: h.oldLines,
      newStart: h.newLines === 0 ? 0 : h.newStart,
      newLines: h.newLines,
      header: findHeader(baseLines, h.oldLines === 0 ? 0 : h.oldStart - 1),
      lines: h.lines,
    };
  });
  // An empty file created or deleted has no lines, but the user still has to be able to decide on it.
  if (hunks.length === 0 && kind !== 'modify') {
    hunks.push({ id: hunkId(0, []), oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, header: '', lines: [] });
  }
  return finishFileChange(path, kind, hunks);
}

/**
 * Builds the file text from `base` plus the given hunks (which must come from `diffFile` over this base). Hunks are
 * applied bottom-up so the base's line numbers stay valid. For a new (or empty) base the style comes from `content`.
 */
export function applyHunks(base: string | null, content: string | null, hunks: DiffHunk[]): string {
  const styleSource = base === null || base === '' ? (content ?? '') : base;
  const eol = detectEol(styleSource);
  const finalNewline = styleSource === '' ? false : /\n$/.test(styleSource);

  const segments = rawSegments(base ?? '');
  for (const h of [...hunks].sort((a, b) => b.oldStart - a.oldStart)) {
    const start = h.oldLines === 0 ? 0 : h.oldStart - 1;
    const replacement: string[] = [];
    let at = start;
    for (const line of h.lines) {
      const sign = line[0];
      if (sign === ' ') replacement.push(segments[at++] as string);
      else if (sign === '-') at++;
      else if (sign === '+') replacement.push(line.slice(1) + eol);
    }
    segments.splice(start, h.oldLines, ...replacement);
  }

  // A kept last line without a terminator may now have lines after it.
  const terminated = segments.map((s, i) => (i < segments.length - 1 && !s.endsWith('\n') ? s + eol : s));
  let text = terminated.join('');
  if (text === '') return '';
  if (finalNewline && !text.endsWith('\n')) text += eol;
  if (!finalNewline && text.endsWith('\n')) text = text.slice(0, text.endsWith('\r\n') ? -2 : -1);
  return text;
}
