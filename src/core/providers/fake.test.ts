import { describe, expect, it } from 'vitest';
import { createFakeProvider, scriptFromTurns, textDeltas } from './fake';
import { ProviderError, type ProviderEvent, type ProviderRequest } from './types';

const readFile = { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } };
const readTerminal = { name: 'read_terminal', description: 'Read the terminal', parameters: { type: 'object' } };

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

  it.each(['write', 'delete'])('[fake:%s] reads its target, then changes it in the same step', async (marker) => {
    const p = createFakeProvider({ delayMs: 0 });
    const tool = { name: `${marker}_file`, description: '', parameters: { type: 'object' } };
    const events = await run(p, userReq(`[fake:${marker}=src/example.txt]`, { tools: [readFile, tool] }));
    const calls = events.flatMap((e) =>
      e.type === 'tool_call' ? [{ name: e.call.name, args: JSON.parse(e.call.argsJson) }] : [],
    );
    expect(calls).toEqual([
      { name: 'read_file', args: { path: 'src/example.txt' } },
      {
        name: `${marker}_file`,
        args:
          marker === 'write'
            ? { path: 'src/example.txt', content: '// created by the fake provider\n' }
            : { path: 'src/example.txt' },
      },
    ]);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('[fake:read=<path>] makes the first tool call read that path', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    const events = await run(p, userReq('look [fake:read=../outside.txt]', { tools: [readFile] }));
    const call = events.find((e) => e.type === 'tool_call');
    expect(call && call.type === 'tool_call' && JSON.parse(call.call.argsJson)).toEqual({ path: '../outside.txt' });
  });

  it('[fake:terminal] calls read_terminal with no arguments when it is offered', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    const events = await run(p, userReq('[fake:terminal]', { tools: [readTerminal] }));
    const call = events.find((e): e is Extract<ProviderEvent, { type: 'tool_call' }> => e.type === 'tool_call');
    expect(call?.call.name).toBe('read_terminal');
    expect(JSON.parse(call?.call.argsJson as string)).toEqual({});
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it("[fake:terminal] then repeats the result's first line", async () => {
    const p = createFakeProvider({ delayMs: 0 });
    const first = await run(p, userReq('[fake:terminal]', { tools: [readTerminal] }));
    const call = first.find((e): e is Extract<ProviderEvent, { type: 'tool_call' }> => e.type === 'tool_call');
    if (!call) throw new Error('no read_terminal call');
    expect(call.call.id).toMatch(/^call_fake_terminal_/);

    const toolText = 'No terminal is open in this chat.\nAsk the user to open one.';
    const events = await run(p, {
      model: 'm',
      system: '',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '[fake:terminal]' }] },
        { role: 'assistant', text: '', toolCalls: [call.call] },
        { role: 'tool', toolCallId: call.call.id, content: toolText },
      ],
      tools: [readTerminal],
    });
    expect(text(events)).toBe('No terminal is open in this chat.');
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('[fake:terminal] does nothing when read_terminal is not offered', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    const events = await run(p, userReq('[fake:terminal]', { tools: [readFile] }));
    expect(events.some((e) => e.type === 'tool_call' && e.call.name === 'read_terminal')).toBe(false);
  });

  it('[fake:terminal] is ignored in title requests', async () => {
    const p = createFakeProvider({ delayMs: 0 });
    const events = await run(p, userReq('[fake:terminal]', { tools: [readTerminal], maxTokens: 30 }));
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
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
