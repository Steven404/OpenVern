import { describe, expect, it } from 'vitest';
import { createFakeProvider, scriptFromTurns, textDeltas } from './fake';
import { ProviderError, type ProviderEvent, type ProviderRequest } from './types';

const readFile = { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } };

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const text = (events: ProviderEvent[]) => events.map((e) => (e.type === 'text_delta' ? e.delta : '')).join('');

describe('FakeProvider default script', () => {
  it('calls read_file on README.md when tools are offered after a user message', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    const req: ProviderRequest = {
      model: 'm',
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [readFile],
    };
    const events = await collect(p.stream(req, new AbortController().signal));
    const call = events.find((e) => e.type === 'tool_call');
    expect(call && call.type === 'tool_call' && JSON.parse(call.call.argsJson)).toEqual({ path: 'README.md' });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('answers with a ts code block after the tool result', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    const req: ProviderRequest = {
      model: 'm',
      system: '',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{}' }] },
        { role: 'tool', toolCallId: 'c1', content: '# readme' },
      ],
      tools: [readFile],
    };
    const events = await collect(p.stream(req, new AbortController().signal));
    expect(text(events)).toContain('```ts');
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
    expect(p.calls).toHaveLength(1);
  });
});

describe('FakeProvider test markers', () => {
  const userReq = (text: string, extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
    model: 'm',
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    ...extra,
  });
  const run = (p: ReturnType<typeof createFakeProvider>, req: ProviderRequest) =>
    collect(p.stream(req, new AbortController().signal));

  it('[fake:error=<code>] fails with that code', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    await expect(run(p, userReq('hi [fake:error=invalid_api_key]'))).rejects.toMatchObject({
      code: 'invalid_api_key',
      retryable: false,
    });
    await expect(run(p, userReq('[fake:error=provider_error]'))).rejects.toMatchObject({ retryable: true });
  });

  it('[fake:flaky] fails once per message, then succeeds', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    await expect(run(p, userReq('x [fake:flaky]'))).rejects.toMatchObject({ code: 'provider_error', retryable: true });
    expect(text(await run(p, userReq('x [fake:flaky]')))).toContain('```ts');
  });

  it('[fake:slow] adds a pause before every text delta', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    const t0 = Date.now();
    let seen = 0;
    for await (const e of p.stream(userReq('[fake:slow]'), new AbortController().signal)) {
      if (e.type === 'text_delta' && ++seen === 3) break;
    }
    expect(Date.now() - t0).toBeGreaterThanOrEqual(330);
  });

  it('[fake:read=<path>] makes the first tool call read that path', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    const events = await run(p, userReq('look [fake:read=../outside.txt]', { tools: [readFile] }));
    const call = events.find((e) => e.type === 'tool_call');
    expect(call && call.type === 'tool_call' && JSON.parse(call.call.argsJson)).toEqual({ path: '../outside.txt' });
  });

  it('ignores the markers in title requests (maxTokens set)', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    expect(text(await run(p, userReq('[fake:error=invalid_api_key]', { maxTokens: 30 })))).toContain('```ts');
  });
});

describe('FakeProvider scripts', () => {
  it('plays turns in order and can throw', async () => {
    const p = createFakeProvider({
      delayMs: 0,
      script: scriptFromTurns([
        [...textDeltas('first'), { type: 'finish', reason: 'stop' }],
        [{ type: 'throw', error: new ProviderError('rate_limited', 'slow down', true, 429) }],
      ]),
    });
    const req: ProviderRequest = { model: 'm', system: '', messages: [] };
    expect(text(await collect(p.stream(req, new AbortController().signal)))).toBe('first');
    await expect(collect(p.stream(req, new AbortController().signal))).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('stops when aborted', async () => {
    const p = createFakeProvider({ delayMs: 5, script: () => textDeltas('x'.repeat(200), 1) });
    const ac = new AbortController();
    const seen: ProviderEvent[] = [];
    const run = (async () => {
      for await (const e of p.stream({ model: 'm', system: '', messages: [] }, ac.signal)) {
        seen.push(e);
        if (seen.length === 3) ac.abort();
      }
    })();
    await expect(run).rejects.toBeDefined();
    expect(seen).toHaveLength(3);
  });

  it('validates keys', async () => {
    const p = createFakeProvider();
    await expect(p.validateKey('sk-or-v1-abc')).resolves.toBeUndefined();
    await expect(p.validateKey('nope')).rejects.toMatchObject({ code: 'invalid_api_key' });
  });
});
