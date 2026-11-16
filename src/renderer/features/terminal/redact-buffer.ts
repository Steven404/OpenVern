import { redactIgnoring, stripTerminalControls } from '@shared/terminal-redact';

// Include invisible characters in runs; define their class once for both extraction and the shared search.
const INVISIBLE =
  '\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u200b-\\u200f\\u2060\\ufeff\\u061c\\u202a-\\u202e\\u2066-\\u2069';
const TOKEN = `[A-Za-z0-9_\\-${INVISIBLE}]`;
const invisible = new RegExp(`[${INVISIBLE}\\n]`, 'g');
const prefix = new RegExp(`^${TOKEN}+`);
// What programs draw beside the text: box-drawing borders, block elements (scrollbars, indent guides), and the
// markers editors put at the start of a wrapped row (`showbreak`).
const BORDER = '|\\u2500-\\u259f';
const WRAP_MARK = '>\\u21aa\\u21b3\\u2026+\\\\';
// A row's last token run, allowing a right-hand border or scrollbar column (and padding) after it.
const TRAIL = `[ \\t${BORDER}]*`;
const suffix = new RegExp(`(${TOKEN}+)${TRAIL}$`);
const trailOnly = new RegExp(`^${TRAIL}$`);
// End the gutter on a separator, never on a digit belonging to the secret itself.
const margin = new RegExp(`^([ \\t0-9${BORDER}${WRAP_MARK}]*[ \\t${BORDER}${WRAP_MARK}])(${TOKEN}+)`);
// Hints only: the shared vendor-pattern search below must still recognise a secret crossing the boundary.
const VENDOR_PREFIXES = [
  'sk-',
  'github_pat_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'glpat-',
  'xoxa-',
  'xoxb-',
  'xoxp-',
  'xoxo-',
  'xoxs-',
  'xoxr-',
  'AKIA',
  'ASIA',
  'AIza',
  'gsk_',
  'xai-',
  'hf_',
  'sk_live_',
  'sk_test_',
  'rk_live_',
  'rk_test_',
  'npm_',
];
const vendorCandidate = (text: string): boolean =>
  text.length > 0 && VENDOR_PREFIXES.some((vendor) => text.startsWith(vendor) || vendor.startsWith(text));
const OMITTED = '«redacted:terminal-fragment»';

/** Repair uncertain screen boundaries before the shared whole-buffer pass. Never change line counts. */
export function redactBufferLines(lines: string[], full: boolean[], firstWrapped = false): string[] {
  const out = [...lines];
  const spans = new Map<number, { start: number; end: number }[]>();
  for (let i = 0; i < lines.length - 1; i++) {
    const tailMatch = lines[i]?.match(suffix);
    const tail = tailMatch?.[1];
    if (!tailMatch || !tail) continue;
    const bareTail = tail.replace(invisible, '');
    let vendor = vendorCandidate(bareTail);
    // A row that is not full still continues below when an editor broke the line at a hyphen or underscore inside the
    // key (vim's `linebreak`): `KEY=sk-or-v1-` on one row, padded with spaces, and the rest on the next.
    if (!full[i] && !(vendor && /[-_]$/.test(bareTail))) continue;
    const pieces = [{ line: i, start: tailMatch.index ?? 0, text: tail }];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      const gutter = vendor ? line.match(margin) : null;
      const text = gutter?.[2] ?? line.match(prefix)?.[0];
      if (!text) break;
      const start = gutter?.[1]?.length ?? 0;
      pieces.push({ line: j, start, text });
      vendor ||= vendorCandidate(text.replace(invisible, ''));
      if (!full[j] || !trailOnly.test(line.slice(start + text.length))) break;
    }
    if (pieces.length < 2) continue;
    const run = pieces.map((piece) => piece.text).join('\n');
    const bare = run.replace(invisible, '');
    const redacted = redactIgnoring(run, invisible, undefined).text;
    let start = 0;
    while (start < bare.length && bare[start] === redacted[start]) start++;
    let unchangedEnd = 0;
    while (
      unchangedEnd < bare.length - start &&
      bare[bare.length - 1 - unchangedEnd] === redacted[redacted.length - 1 - unchangedEnd]
    )
      unchangedEnd++;
    let boundary = 0;
    const crosses = pieces.slice(0, -1).some((piece) => {
      boundary += piece.text.replace(invisible, '').length;
      return start < boundary && bare.length - unchangedEnd > boundary;
    });
    if (crosses) {
      // Only the pieces the secret actually reaches: a word on a later row that merely followed it stays.
      const changedEnd = bare.length - unchangedEnd;
      let offset = 0;
      for (const piece of pieces) {
        const length = piece.text.replace(invisible, '').length;
        if (offset < changedEnd && offset + length > start) {
          const ranges = spans.get(piece.line) ?? [];
          ranges.push({ start: piece.start, end: piece.start + piece.text.length });
          spans.set(piece.line, ranges);
        }
        offset += length;
      }
    }
    i = (pieces.at(-1)?.line ?? i + 1) - 1;
  }

  for (const [index, ranges] of spans) {
    const merged: { start: number; end: number }[] = [];
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
    }
    for (const range of merged.reverse()) {
      const line = out[index] ?? '';
      out[index] = line.slice(0, range.start) + OMITTED + line.slice(range.end);
    }
  }

  // Orphan headers must not reach the shared file-oriented PEM pattern, which would eat all later output.
  const plain = lines.map((line) => stripTerminalControls(line).replace(invisible, ''));
  const headers = plain.flatMap((line, index) => {
    const match = /-----(BEGIN|END)([ A-Z0-9]*PRIVATE KEY)-----/.exec(line);
    if (!match) return [];
    return [
      { index, begin: match[1] === 'BEGIN', label: match[2] ?? '', gutter: gutterPattern(line.slice(0, match.index)) },
    ];
  });
  // A BEGIN and an END far apart are one block only when everything between them looks like a key. Otherwise they are
  // two separate sightings (a `grep` near the top, a `tail` an hour later) and the output between them is not a key.
  const paired = new Set<number>();
  const pending = new Map<string, (typeof headers)[number][]>();
  for (const header of headers) {
    const stack = pending.get(header.label) ?? [];
    pending.set(header.label, stack);
    if (header.begin) {
      stack.push(header);
      continue;
    }
    const begin = stack.pop();
    if (!begin) continue;
    let blanks = 0;
    let whole = true;
    for (let j = begin.index + 1; j < header.index && whole; j++) {
      const kind = keyLineKind(plain[j] ?? '', begin.gutter);
      if (kind === 'blank') blanks++;
      whole = kind !== 'other' && blanks <= 1;
    }
    // A short stretch is taken as one block whatever it holds: no key is longer, and hiding it is the safe mistake.
    if (whole || header.index - begin.index - 1 <= KEY_BLOCK_MAX_LINES) {
      paired.add(begin.index);
      paired.add(header.index);
      // Left as it is for the shared pattern, which redacts a complete block whole, gutters or not.
    }
  }
  for (const header of headers) {
    if (paired.has(header.index)) continue;
    out[header.index] = OMITTED;
    const step = header.begin ? 1 : -1;
    let blanks = 0;
    for (let j = header.index + step; j >= 0 && j < lines.length; j += step) {
      const kind = keyLineKind(plain[j] ?? '', header.gutter);
      // One blank line is part of an old-style encrypted key, after its `Proc-Type` and `DEK-Info` lines.
      if (kind === 'other' || (kind === 'blank' && ++blanks > 1)) break;
      out[j] = OMITTED;
    }
  }
  if (firstWrapped) out[0] = (out[0] ?? '').replace(prefix, OMITTED);
  return out;
}

/**
 * What stands in front of a key header on its line, as a pattern for the same thing on the neighbouring lines: a
 * line-number gutter (`  12 `, `  12   │ `), a diff sign, or a `grep` file prefix (`keys/a.pem:3:`, which reads
 * `keys/a.pem-4-` on its context lines). Digits match any digits and spaces any spaces, so line 9 and line 10 agree.
 */
function gutterPattern(before: string): RegExp | null {
  if (before === '') return null;
  const source = before
    .replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
    .replace(/\d+/g, '\\d+')
    .replace(/\s+/g, '\\s*')
    .replace(/:/g, '[:-]');
  return new RegExp(`^\\s*${source}`);
}

/** More lines than any private key has between its header lines (an 8192-bit RSA key has about 100). */
const KEY_BLOCK_MAX_LINES = 120;

/** Leading characters a program may draw before each line of a file: numbers, spaces, borders, diff and wrap signs. */
const GENERIC_GUTTER = /^[\s\d│┃|:+\-▏▎▐>↪↳]*/;

/**
 * Whether a line next to a private-key header belongs to the key: `body` for base64-shaped text (with or without
 * the header's gutter, or a generic one), `header` for the lines of an old-style encrypted key, `blank`, or `other`.
 * Too generous is fine here: hiding a neighbouring line costs little, showing a key body does not.
 */
function keyLineKind(line: string, gutter: RegExp | null): 'body' | 'header' | 'blank' | 'other' {
  const candidates = [line, line.replace(GENERIC_GUTTER, '')];
  if (gutter) {
    const stripped = line.replace(gutter, '');
    candidates.push(stripped, stripped.replace(GENERIC_GUTTER, ''));
  }
  let blank = false;
  for (const candidate of candidates) {
    const text = candidate.trim();
    if (text === '') blank = true;
    else if (/^(?:Proc-Type|DEK-Info):/.test(text)) return 'header';
    else if (text.length >= 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(text)) return 'body';
  }
  return blank ? 'blank' : 'other';
}
