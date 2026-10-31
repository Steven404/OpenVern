// Automatic chat titles (S4.10).

import type { Provider } from '../providers/types';

export const TITLE_TIMEOUT_MS = 10_000;
export const TITLE_MAX_TOKENS = 30;
const TITLE_INPUT_MAX_CHARS = 1000;
const TITLE_MAX_CHARS = 80;
const FALLBACK_MAX_CHARS = 60;

const TITLE_SYSTEM =
  'You write short titles for chat conversations. Reply with a title of 3 to 6 words for the conversation that starts with ' +
  "the user's message. Reply with the title only: no quotes, no markdown, no trailing punctuation.";

/** Cleans a model-produced title. Returns `null` when nothing usable is left. */
export function cleanTitle(raw: string): string | null {
  // First non-empty line only: models sometimes add an explanation below the title.
  let t = raw.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  t = t.trim();
  t = t.replace(/^(?:#+\s*|title\s*:\s*)/i, '');
  // Strip wrapping quotes / emphasis / backticks, repeatedly (e.g. **"Title"**).
  const wrap = /^["'`“”‘’*_]+|["'`“”‘’*_]+$/g;
  t = t.replace(wrap, '').trim();
  t = t.replace(/[\s.!?:;,…。]+$/u, '');
  t = t.replace(wrap, '').trim();
  t = t.replace(/\s+/g, ' ');
  if (t.length > TITLE_MAX_CHARS) t = `${t.slice(0, TITLE_MAX_CHARS).trimEnd()}…`;
  return t.length > 0 ? t : null;
}

/** First 60 characters of the message (whitespace collapsed); first attachment name if the text is empty. */
export function fallbackTitle(text: string, attachmentNames: string[] = []): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length > 0) return t.length > FALLBACK_MAX_CHARS ? t.slice(0, FALLBACK_MAX_CHARS).trimEnd() : t;
  const name = attachmentNames[0]?.trim();
  return name ? name.slice(0, FALLBACK_MAX_CHARS) : null;
}

export interface GenerateTitleInput {
  provider: Provider;
  model: string;
  text: string;
  attachmentNames?: string[];
  signal: AbortSignal;
  timeoutMs?: number;
}

/** Asks the model for a title. Never throws: any failure, timeout, abort or empty reply → the fallback (or null). */
export async function generateTitle(input: GenerateTitleInput): Promise<string | null> {
  const fallback = fallbackTitle(input.text, input.attachmentNames);
  if (input.signal.aborted) return fallback;

  const names = input.attachmentNames ?? [];
  const body = (input.text.trim() || (names.length > 0 ? `[Attached: ${names.join(', ')}]` : '')).slice(
    0,
    TITLE_INPUT_MAX_CHARS,
  );
  if (body.length === 0) return fallback;

  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? TITLE_TIMEOUT_MS)]);
  try {
    let raw = '';
    for await (const ev of input.provider.stream(
      {
        model: input.model,
        system: TITLE_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: body }] }],
        maxTokens: TITLE_MAX_TOKENS,
      },
      signal,
    )) {
      if (ev.type === 'text_delta') raw += ev.delta;
      if (signal.aborted) return fallback;
    }
    if (signal.aborted) return fallback;
    return cleanTitle(raw) ?? fallback;
  } catch {
    return fallback;
  }
}
