import { redactIgnoring, stripTerminalControls } from '@shared/terminal-redact';

// Include invisible characters in runs; define their class once for both extraction and the shared search.
const INVISIBLE =
  '\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u200b-\\u200f\\u2060\\ufeff\\u061c\\u202a-\\u202e\\u2066-\\u2069';
const TOKEN = `[A-Za-z0-9_\\-${INVISIBLE}]`;
const invisible = new RegExp(`[${INVISIBLE}\\n]`, 'g');
const suffix = new RegExp(`${TOKEN}+$`);
const prefix = new RegExp(`^${TOKEN}+`);
const BORDER = '|\\u2500-\\u257f';
// End the gutter on a separator, never on a digit belonging to the secret itself.
const margin = new RegExp(`^([ \\t0-9${BORDER}]*[ \\t${BORDER}])(${TOKEN}+)`);
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
    if (!full[i]) continue;
    const tail = lines[i]?.match(suffix)?.[0];
    if (!tail) continue;
    let vendor = vendorCandidate(tail.replace(invisible, ''));
    const pieces = [{ line: i, start: (lines[i]?.length ?? 0) - tail.length, text: tail }];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      const gutter = vendor ? line.match(margin) : null;
      const text = gutter?.[2] ?? line.match(prefix)?.[0];
      if (!text) break;
      const start = gutter?.[1]?.length ?? 0;
      pieces.push({ line: j, start, text });
      vendor ||= vendorCandidate(text.replace(invisible, ''));
      if (!full[j] || start + text.length !== line.length) break;
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
      for (const piece of pieces) {
        const ranges = spans.get(piece.line) ?? [];
        ranges.push({ start: piece.start, end: piece.start + piece.text.length });
        spans.set(piece.line, ranges);
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
    return match ? [{ index, begin: match[1] === 'BEGIN', label: match[2] ?? '' }] : [];
  });
  const paired = new Set<number>();
  const pending = new Map<string, number[]>();
  for (const header of headers) {
    const stack = pending.get(header.label) ?? [];
    if (header.begin) stack.push(header.index);
    else {
      const begin = stack.pop();
      if (begin !== undefined) {
        paired.add(begin);
        paired.add(header.index);
      }
    }
    pending.set(header.label, stack);
  }
  for (const header of headers) {
    if (paired.has(header.index)) continue;
    out[header.index] = OMITTED;
    const step = header.begin ? 1 : -1;
    for (let j = header.index + step; j >= 0 && j < lines.length; j += step) {
      const body = plain[j]?.trim() ?? '';
      if (body.length < 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) break;
      out[j] = OMITTED;
    }
  }
  if (firstWrapped) out[0] = (out[0] ?? '').replace(prefix, OMITTED);
  return out;
}
