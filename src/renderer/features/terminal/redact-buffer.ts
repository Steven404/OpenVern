import { redactIgnoring, stripTerminalControls } from '@shared/terminal-redact';

// Include invisible characters in a run so the shared search sees the entire token.
const TOKEN =
  '[A-Za-z0-9_\\-\\u200b-\\u200f\\u2060\\ufeff\\u061c\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]';
const suffix = new RegExp(`${TOKEN}+$`);
const prefix = new RegExp(`^${TOKEN}+`);
const allToken = new RegExp(`^${TOKEN}+$`);
const OMITTED = '«redacted:terminal-fragment»';

/** Repair uncertain screen boundaries before the shared whole-buffer pass. Never change line counts. */
export function redactBufferLines(lines: string[], full: boolean[], firstWrapped = false): string[] {
  const out = [...lines];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!full[i]) continue;
    const tail = lines[i]?.match(suffix)?.[0];
    if (!tail || !lines[i + 1]?.match(prefix)) continue;
    let end = i + 1;
    while (full[end] && allToken.test(lines[end] ?? '') && lines[end + 1]?.match(prefix)) end++;
    const head = lines[end]?.match(prefix)?.[0] ?? '';
    const run = [tail, ...lines.slice(i + 1, end), head].join('\n');
    // Newlines in this one token run are screen boundaries, not semantic separators.
    const invisible =
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal controls are invisible to the shared search
      /[\n\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u200b-\u200f\u2060\ufeff\u061c\u202a-\u202e\u2066-\u2069]/g;
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
    const crosses = [tail, ...lines.slice(i + 1, end)].some((piece) => {
      boundary += piece.replace(invisible, '').length;
      return start < boundary && bare.length - unchangedEnd > boundary;
    });
    if (crosses) {
      out[i] = (out[i] ?? '').slice(0, -tail.length) + OMITTED;
      for (let j = i + 1; j < end; j++) out[j] = OMITTED;
      out[end] = OMITTED + (out[end] ?? '').slice(head.length);
    }
    i = end - 1;
  }
  // A trimmed scrollback/replay may have lost the private-key header.
  let begin = false;
  for (let i = 0; i < lines.length; i++) {
    const line = stripTerminalControls(lines[i] ?? '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '');
    if (/-----BEGIN[ A-Z0-9]*PRIVATE KEY-----/.test(line)) begin = true;
    if (/-----END[ A-Z0-9]*PRIVATE KEY-----/.test(line)) {
      if (!begin) for (let j = 0; j <= i; j++) out[j] = j === 0 ? OMITTED : '';
      begin = false;
    }
  }
  if (firstWrapped) out[0] = (out[0] ?? '').replace(prefix, OMITTED);
  return out;
}
