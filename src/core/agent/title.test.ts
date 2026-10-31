import { describe, expect, it } from 'vitest';
import { createFakeProvider, scriptFromTurns, textDeltas } from '../providers/fake';
import { ProviderError } from '../providers/types';
import { cleanTitle, fallbackTitle, generateTitle } from './title';

describe('cleanTitle', () => {
  it.each([
    ['"Fix the login bug."', 'Fix the login bug'],
    ["'Quoted title'", 'Quoted title'],
    ['“Curly quotes”', 'Curly quotes'],
    ['Title: Debugging a race condition!', 'Debugging a race condition'],
    ['# Heading style', 'Heading style'],
    ['**Bold title**', 'Bold title'],
    ['Trailing dots...', 'Trailing dots'],
    ['Question title?', 'Question title'],
    ['First line\nSecond line explanation', 'First line'],
    ['\n\n  Leading blank lines  \n', 'Leading blank lines'],
    ['  spaced   out   words ', 'spaced out words'],
    ['`code`.', 'code'],
  ])('%j → %j', (raw, expected) => {
    expect(cleanTitle(raw)).toBe(expected);
  });

  it('returns null for empty or punctuation-only replies', () => {
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('  \n ')).toBeNull();
    expect(cleanTitle('"..."')).toBeNull();
  });

  it('caps very long titles', () => {
    const t = cleanTitle('word '.repeat(50));
    expect(t?.length).toBeLessThanOrEqual(81);
    expect(t?.endsWith('…')).toBe(true);
  });
});

describe('fallbackTitle', () => {
  it('uses the first 60 characters with whitespace collapsed', () => {
    expect(fallbackTitle(`a\n\n  b ${'c'.repeat(100)}`)?.length).toBe(60);
    expect(fallbackTitle('  short\nmessage ')).toBe('short message');
  });
  it('uses the first attachment name when there is no text', () => {
    expect(fallbackTitle('  ', ['notes.md'])).toBe('notes.md');
    expect(fallbackTitle('', [])).toBeNull();
  });
});

describe('generateTitle', () => {
  const base = { model: 'm', text: 'How do I debounce in React?', signal: new AbortController().signal };

  it('returns the cleaned model title', async () => {
    const provider = createFakeProvider({
      delayMs: 0,
      script: scriptFromTurns([[...textDeltas('"Debouncing in React."'), { type: 'finish', reason: 'stop' }]]),
    });
    expect(await generateTitle({ ...base, provider })).toBe('Debouncing in React');
    expect(provider.calls[0]).toMatchObject({ model: 'm', maxTokens: 30 });
    expect(provider.calls[0]?.tools).toBeUndefined();
  });

  it('falls back on provider errors, empty replies and aborts', async () => {
    const failing = createFakeProvider({
      delayMs: 0,
      script: () => [{ type: 'throw', error: new ProviderError('provider_error', 'x') }],
    });
    expect(await generateTitle({ ...base, provider: failing })).toBe(base.text);
    const empty = createFakeProvider({ delayMs: 0, script: () => [{ type: 'finish', reason: 'stop' }] });
    expect(await generateTitle({ ...base, provider: empty })).toBe(base.text);
    const aborted = new AbortController();
    aborted.abort();
    const ok = createFakeProvider({ delayMs: 0, script: () => textDeltas('Never used') });
    expect(await generateTitle({ ...base, provider: ok, signal: aborted.signal })).toBe(base.text);
    expect(ok.calls).toHaveLength(0);
  });

  it('times out', async () => {
    const slow = createFakeProvider({
      delayMs: 0,
      script: () => [{ type: 'delay', ms: 60_000 }, ...textDeltas('Late')],
    });
    expect(await generateTitle({ ...base, provider: slow, timeoutMs: 10 })).toBe(base.text);
  });
});
