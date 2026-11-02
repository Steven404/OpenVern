// Secret redaction for text that reaches the model (plan K1). Pure, no I/O.
//
// Three passes, in order:
//   1. Exact values the app knows (its own stored key): catches the key even without a recognisable prefix, e.g. a
//      hardlink of `secrets.json` under an allowed name.
//   2. Vendor-prefixed tokens (`sk-or-v1-…`, `ghp_…`, `AKIA…`, …).
//   3. PEM private-key blocks.
// Matches become a non-reusable sentinel that keeps at most the public vendor prefix, never a tail: a head/tail mask
// leaks bits and invites the model to write a truncated key back into a file. Every replacement keeps the number of
// line breaks of what it replaced, so line numbers computed after redaction still match the file.

export interface RedactOptions {
  /** Exact secret values to remove wherever they appear (values shorter than 8 characters are ignored). */
  known?: readonly string[];
}

export interface RedactResult {
  text: string;
  /** Number of values replaced. */
  count: number;
}

/** `«redacted:<label>»`. Exported so tests and the system prompt agree on the shape. */
export function sentinel(label: string): string {
  return `«redacted:${label}»`;
}

const STORED_KEY_SENTINEL = sentinel('stored-key');
const PRIVATE_KEY_SENTINEL = sentinel('private-key');
const MIN_KNOWN_LENGTH = 8;

/**
 * Vendor token patterns. `source` is the regex source of the whole token; `keep` is how many leading characters of a
 * match are the public vendor prefix, kept in the sentinel. Bodies only use `[A-Za-z0-9_-]`-style classes so a match
 * never runs past the token. Strong prefixes (unambiguous in normal text) accept short bodies, so a key cut by an
 * output limit is still caught.
 */
export const SECRET_PATTERNS: readonly { source: string; keep: number | RegExp }[] = [
  { source: 'sk-or-v1-[0-9a-fA-F]{8,}', keep: 9 },
  { source: 'sk-ant-[A-Za-z0-9_-]{8,}', keep: 7 },
  { source: 'sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{10,}', keep: /^sk-[a-z]+-/ },
  // Generic `sk-` (OpenAI legacy, DeepSeek, …): long body with at least one digit, to spare `sk-some-css-class-name`.
  { source: 'sk-(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}', keep: 3 },
  { source: 'github_pat_[A-Za-z0-9_]{20,}', keep: 11 },
  { source: 'gh[pousr]_[A-Za-z0-9]{20,}', keep: 4 },
  { source: 'glpat-[A-Za-z0-9_-]{20,}', keep: 6 },
  { source: 'xox[abposr]-[A-Za-z0-9-]{10,}', keep: 5 },
  { source: '(?:AKIA|ASIA)[0-9A-Z]{16}', keep: 4 },
  { source: 'AIza[0-9A-Za-z_-]{35}', keep: 4 },
  { source: 'gsk_[A-Za-z0-9]{20,}', keep: 4 },
  { source: 'xai-[A-Za-z0-9]{20,}', keep: 4 },
  { source: 'hf_(?=[A-Za-z]*[0-9])[A-Za-z0-9]{20,}', keep: 3 },
  { source: '[sr]k_(?:live|test)_[A-Za-z0-9]{16,}', keep: 8 },
  { source: 'npm_[A-Za-z0-9]{36}', keep: 4 },
];

// One alternation with a capture group per pattern, so the replacer knows which prefix matched. The lookbehind stops
// matches inside a longer identifier (`task-runner`, `my_ghp_x`).
const TOKEN_RE = new RegExp(`(?<![A-Za-z0-9_-])(?:${SECRET_PATTERNS.map((p) => `(${p.source})`).join('|')})`, 'g');

// A block cut by an output limit (no END line) is redacted to the end of the text.
const PEM_RE = /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----[\s\S]*?(?:-----END[ A-Z0-9]*PRIVATE KEY-----|$(?![\s\S]))/g;

function keepNewlines(match: string, replacement: string): string {
  const breaks = match.split('\n').length - 1;
  return breaks > 0 ? replacement + '\n'.repeat(breaks) : replacement;
}

export function redactSecrets(text: string, opts: RedactOptions = {}): RedactResult {
  let count = 0;
  let out = text;

  for (const value of opts.known ?? []) {
    if (value.length < MIN_KNOWN_LENGTH || !out.includes(value)) continue;
    const parts = out.split(value);
    count += parts.length - 1;
    out = parts.join(STORED_KEY_SENTINEL);
  }

  out = out.replace(TOKEN_RE, (...args: unknown[]) => {
    count++;
    const groups = args.slice(1, 1 + SECRET_PATTERNS.length);
    const index = groups.findIndex((g) => g !== undefined);
    const match = args[0] as string;
    const keep = SECRET_PATTERNS[index]?.keep ?? 0;
    const prefix = typeof keep === 'number' ? match.slice(0, keep) : (keep.exec(match)?.[0] ?? '');
    return sentinel(`${prefix}…`);
  });

  out = out.replace(PEM_RE, (match) => {
    count++;
    return keepNewlines(match, PRIVATE_KEY_SENTINEL);
  });

  return { text: out, count };
}

/** One-line note appended to a tool result when something was redacted. */
export function redactionNote(count: number): string {
  return `[${count} secret-looking value${count === 1 ? ' was' : 's were'} replaced with «redacted:…» placeholders. The file itself is unchanged; never write these placeholders back into a file.]`;
}
