import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '@shared/constants';
import { ERROR_DEFAULTS } from '@shared/errors';
import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterProvider, mapModels } from './openrouter';
import { type Provider, ProviderError, type ProviderEvent, type ProviderRequest } from './types';

// A value that differs from the real constant, so the attribution test fails if the name is hard-coded.
vi.mock('@shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/constants')>()),
  APP_NAME: 'renamed-app',
}));

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');

// ── test helpers ───────────────────────────────────────────────────────────────────────────────

/** A streaming body that delivers `text` as UTF-8 bytes split every `chunkSize` bytes. */
function sseBody(text: string, chunkSize = Number.POSITIVE_INFINITY): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const size = Math.min(chunkSize, bytes.length) || 1;
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });
}

const sseResponse = (text: string, chunkSize?: number) =>
  new Response(sseBody(text, chunkSize), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  // biome-ignore lint/suspicious/noExplicitAny: parsed request body in tests
  body: Record<string, any>;
}

function fakeFetch(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      init: init ?? {},
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const REQ: ProviderRequest = {
  model: 'anthropic/claude-sonnet-4.5',
  system: 'You are helpful.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

function make(respond: Parameters<typeof fakeFetch>[0], key: string | null = 'sk-or-v1-test') {
  const f = fakeFetch(respond);
  const provider = createOpenRouterProvider({ getApiKey: async () => key, fetch: f.fetch });
  return { provider, calls: f.calls };
}

async function collect(provider: Provider, req = REQ, signal = new AbortController().signal) {
  const events: ProviderEvent[] = [];
  for await (const e of provider.stream(req, signal)) events.push(e);
  return events;
}

async function caught(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error('expected rejection');
}

// ── S2.1 / S2.2: request mapping ───────────────────────────────────────────────────────────────

describe('request mapping', () => {
  it('posts to /chat/completions with auth + attribution headers and stream: true', async () => {
    const { provider, calls } = make(() => sseResponse(fixture('text-stream.sse')));
    await collect(provider);
    const c = calls[0];
    expect(c?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(c?.init.method).toBe('POST');
    expect(c?.headers.Authorization).toBe('Bearer sk-or-v1-test');
    expect(APP_NAME).toBe('renamed-app'); // the mock above is in effect
    expect(c?.headers['X-OpenRouter-Title']).toBe(APP_NAME);
    expect(c?.headers['X-Title']).toBe(APP_NAME);
    expect(c?.headers['HTTP-Referer']).toBeUndefined();
    expect(c?.body.stream).toBe(true);
    expect(c?.body.model).toBe('anthropic/claude-sonnet-4.5');
    expect(c?.body.tools).toBeUndefined();
    expect(c?.body.max_tokens).toBeUndefined();
  });

  it('maps system, user text+image, assistant tool calls, tool results and tools', async () => {
    const { provider, calls } = make(() => sseResponse(fixture('text-stream.sse')));
    await collect(provider, {
      model: 'm',
      system: 'SYS',
      maxTokens: 123,
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', mime: 'image/png', base64: 'QUJD' },
          ],
        },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call_1', name: 'read_file', argsJson: '{"path":"a.ts"}' }],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'file contents' },
        { role: 'assistant', text: 'done', toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
      ],
    });
    const body = calls[0]?.body ?? {};
    expect(body.max_tokens).toBe(123);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
      },
    ]);
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('omits tools when the list is empty', async () => {
    const { provider, calls } = make(() => sseResponse(fixture('text-stream.sse')));
    await collect(provider, { ...REQ, tools: [] });
    expect(calls[0]?.body.tools).toBeUndefined();
  });

  // ── F3: reasoning effort ──
  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'sends reasoning.effort = %s when the request has that effort',
    async (effort) => {
      const { provider, calls } = make(() => sseResponse(fixture('text-stream.sse')));
      await collect(provider, { ...REQ, effort });
      expect(calls[0]?.body.reasoning).toEqual({ effort });
    },
  );

  it('sends no reasoning key at all when the request has no effort (Default)', async () => {
    const { provider, calls } = make(() => sseResponse(fixture('text-stream.sse')));
    await collect(provider, REQ);
    expect(calls[0]?.body).not.toHaveProperty('reasoning');
  });

  it('sends no reasoning key when effort is null (a cleared setting, cast past the optional type)', async () => {
    const { provider, calls } = make(() => sseResponse(fixture('text-stream.sse')));
    await collect(provider, { ...REQ, effort: null as unknown as ProviderRequest['effort'] });
    expect(calls[0]?.body).not.toHaveProperty('reasoning');
  });

  it('throws no_api_key without calling fetch when there is no key', async () => {
    const { provider, calls } = make(() => sseResponse(''), null);
    const err = await caught(collect(provider));
    expect(err.code).toBe('no_api_key');
    expect(calls).toHaveLength(0);
  });
});

// ── S2.3: stream parsing ───────────────────────────────────────────────────────────────────────

describe('stream parsing', () => {
  const textEvents: ProviderEvent[] = [
    { type: 'text_delta', delta: 'Hello' },
    { type: 'text_delta', delta: ', wörld! 👋' },
    { type: 'usage', usage: { promptTokens: 14, completionTokens: 9, costUsd: 0.000177 } },
    { type: 'finish', reason: 'stop' },
  ];

  it('text-only stream: keepalives ignored, one usage, one finish, [DONE] ends it', async () => {
    const { provider } = make(() => sseResponse(fixture('text-stream.sse')));
    expect(await collect(provider)).toEqual(textEvents);
  });

  it('stops reading at [DONE]: later frames are ignored', async () => {
    const sse = `${fixture('text-stream.sse').trimEnd()}\n\ndata: {"choices":[{"index":0,"delta":{"content":"late"},"finish_reason":null}]}\n\ndata: {not json\n\n`;
    expect(sse).toContain('data: [DONE]');
    const { provider } = make(() => sseResponse(sse));
    expect(await collect(provider)).toEqual(textEvents);
  });

  it.each([1, 2, 3, 7, 50, 333])('is identical when the body is split into %i-byte chunks', async (size) => {
    const { provider } = make(() => sseResponse(fixture('text-stream.sse'), size));
    expect(await collect(provider)).toEqual(textEvents);
  });

  it('parallel tool calls: accumulates arguments by index, emits when the choice finishes', async () => {
    const { provider } = make(() => sseResponse(fixture('parallel-tool-calls.sse')));
    const events = await collect(provider);
    expect(events).toEqual([
      { type: 'text_delta', delta: 'Let me look.' },
      { type: 'tool_call', call: { id: 'call_aaa', name: 'read_file', argsJson: '{"path": "README.md"}' } },
      { type: 'tool_call', call: { id: 'call_bbb', name: 'list_files', argsJson: '{"dir":"src"}' } },
      { type: 'usage', usage: { promptTokens: 210, completionTokens: 55, costUsd: 0.0012 } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
    for (const e of events) if (e.type === 'tool_call') expect(() => JSON.parse(e.call.argsJson)).not.toThrow();
  });

  it('parallel tool calls survive awkward chunk boundaries', async () => {
    const whole = await collect(make(() => sseResponse(fixture('parallel-tool-calls.sse'))).provider);
    const split = await collect(make(() => sseResponse(fixture('parallel-tool-calls.sse'), 5)).provider);
    expect(split).toEqual(whole);
  });

  it('emits no tool_call before the choice finishes', async () => {
    const f = fixture('parallel-tool-calls.sse');
    // Cut the stream right before the finish chunk.
    const cut = f.slice(0, f.indexOf('"finish_reason":"tool_calls"'));
    const { provider } = make(() => sseResponse(`${cut.slice(0, cut.lastIndexOf('data: '))}`));
    const seen: ProviderEvent[] = [];
    const err = await caught(
      (async () => {
        for await (const e of provider.stream(REQ, new AbortController().signal)) seen.push(e);
      })(),
    );
    expect(seen.some((e) => e.type === 'tool_call')).toBe(false);
    expect(err.code).toBe('network_error'); // stream ended with neither finish_reason nor [DONE]
  });

  it('uses {} for tool calls with empty arguments and reports tool_calls as the finish reason', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"list_files","arguments":""}}]},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const events = await collect(make(() => sseResponse(sse)).provider);
    expect(events).toEqual([
      { type: 'tool_call', call: { id: 'c1', name: 'list_files', argsJson: '{}' } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
  });

  it('maps finish reasons', async () => {
    const run = async (reason: string) => {
      const sse = `data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"${reason}"}]}\n\ndata: [DONE]\n\n`;
      return (await collect(make(() => sseResponse(sse)).provider)).at(-1);
    };
    expect(await run('length')).toEqual({ type: 'finish', reason: 'length' });
    expect(await run('content_filter')).toEqual({ type: 'finish', reason: 'other' });
  });
});

// ── S2.4: mid-stream errors ────────────────────────────────────────────────────────────────────

describe('mid-stream errors', () => {
  it('throws ProviderError after the text already streamed, without finish', async () => {
    const { provider } = make(() => sseResponse(fixture('midstream-error.sse')));
    const seen: ProviderEvent[] = [];
    const err = await caught(
      (async () => {
        for await (const e of provider.stream(REQ, new AbortController().signal)) seen.push(e);
      })(),
    );
    expect(seen).toEqual([{ type: 'text_delta', delta: 'Partial answer' }]);
    expect(err.code).toBe('provider_error');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('Provider disconnected unexpectedly');
  });

  it('maps numeric/typed mid-stream error codes through the same table', async () => {
    const chunk = (error: unknown) =>
      `data: ${JSON.stringify({ error, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })}\n\n`;
    const run = (error: unknown) => caught(collect(make(() => sseResponse(chunk(error))).provider));
    expect((await run({ code: 429, message: 'slow down' })).code).toBe('rate_limited');
    expect((await run({ code: 'x', message: 'y', metadata: { error_type: 'rate_limit_exceeded' } })).code).toBe(
      'rate_limited',
    );
    expect((await run({ code: 400, message: 'maximum context length is 8192 tokens' })).code).toBe(
      'context_length_exceeded',
    );
  });

  it('a bare finish_reason "error" without an error object is still a ProviderError', async () => {
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n';
    const err = await caught(collect(make(() => sseResponse(sse)).provider));
    expect(err.code).toBe('provider_error');
  });

  it('a dropped connection mid-body becomes network_error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
      },
      pull() {
        throw new TypeError('terminated');
      },
    });
    const { provider } = make(() => new Response(body, { status: 200 }));
    const err = await caught(collect(provider));
    expect(err.code).toBe('network_error');
    expect(err.retryable).toBe(true);
  });
});

// ── S2.5: error mapping ────────────────────────────────────────────────────────────────────────

describe('error mapping (pre-stream HTTP errors)', () => {
  const cases: {
    name: string;
    status: number;
    body: unknown;
    code: string;
    retryable: boolean;
  }[] = [
    {
      name: '401',
      status: 401,
      body: { error: { code: 401, message: 'No auth credentials found' } },
      code: 'invalid_api_key',
      retryable: false,
    },
    {
      name: '402',
      status: 402,
      body: { error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/credits' } },
      code: 'insufficient_credits',
      retryable: false,
    },
    {
      name: '429',
      status: 429,
      body: { error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } } },
      code: 'rate_limited',
      retryable: true,
    },
    {
      name: 'context length (400)',
      status: 400,
      body: {
        error: {
          code: 400,
          message:
            "This endpoint's maximum context length is 200000 tokens. However, you requested about 250000 tokens.",
        },
      },
      code: 'context_length_exceeded',
      retryable: false,
    },
    {
      name: 'context length (upstream raw)',
      status: 400,
      body: {
        error: {
          code: 400,
          message: 'Provider returned error',
          metadata: { raw: 'prompt is too long: 250000 tokens > 200000 maximum', provider_name: 'Anthropic' },
        },
      },
      code: 'context_length_exceeded',
      retryable: false,
    },
    {
      name: 'no tool-use endpoints (404)',
      status: 404,
      body: { error: { code: 404, message: 'No endpoints found that support tool use. Try disabling "tools".' } },
      code: 'model_no_tools',
      retryable: false,
    },
    {
      name: 'model not found (400)',
      status: 400,
      body: { error: { code: 400, message: 'foo/bar is not a valid model ID' } },
      code: 'model_unavailable',
      retryable: false,
    },
    {
      name: 'no endpoints for model (404)',
      status: 404,
      body: { error: { code: 404, message: 'No endpoints found for foo/bar.' } },
      code: 'model_unavailable',
      retryable: false,
    },
    {
      name: '502',
      status: 502,
      body: {
        error: { code: 502, message: 'Provider returned error', metadata: { error_type: 'provider_unavailable' } },
      },
      code: 'provider_error',
      retryable: true,
    },
    {
      name: '503',
      status: 503,
      body: { error: { code: 503, message: 'No available model provider that meets your routing requirements' } },
      code: 'provider_error',
      retryable: true,
    },
    {
      name: '500 with a non-JSON body',
      status: 500,
      body: 'Internal Server Error',
      code: 'provider_error',
      retryable: true,
    },
    {
      name: '403 (moderation / budget)',
      status: 403,
      body: { error: { code: 403, message: 'Your chosen model requires moderation' } },
      code: 'provider_error',
      retryable: false,
    },
    {
      name: 'other 400',
      status: 400,
      body: { error: { code: 400, message: 'Invalid tool schema' } },
      code: 'invalid_request',
      retryable: false,
    },
  ];

  it.each(cases)('$name → $code', async ({ status, body, code, retryable }) => {
    const { provider } = make(() =>
      typeof body === 'string' ? new Response(body, { status }) : jsonResponse(status, body),
    );
    const err = await caught(collect(provider));
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.status).toBe(status);
  });

  it('fetch failure → network_error (retryable)', async () => {
    const { provider } = make(() => {
      throw new TypeError('fetch failed');
    });
    const err = await caught(collect(provider));
    expect(err.code).toBe('network_error');
    expect(err.retryable).toBe(true);
  });

  it('a non-JSON (HTML) error body is used only to classify; the message stays the default copy', async () => {
    const html =
      '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<head><title>openrouter.ai | 524: A timeout occurred</title></head>';
    const { provider } = make(() => new Response(html, { status: 524, headers: { 'Content-Type': 'text/html' } }));
    const err = await caught(collect(provider));
    expect(err.code).toBe('provider_error');
    expect(err.status).toBe(524);
    expect(err.message).toBe(ERROR_DEFAULTS.provider_error.message);
    expect(err.message).not.toContain('<');

    const bad = make(() => new Response('<html><body>Bad Request</body></html>', { status: 400 }));
    const err400 = await caught(collect(bad.provider));
    expect(err400.code).toBe('invalid_request');
    expect(err400.message).toBe(ERROR_DEFAULTS.invalid_request.message);

    // Non-JSON text still drives classification.
    const ctx = make(() => new Response('maximum context length exceeded', { status: 400 }));
    expect((await caught(collect(ctx.provider))).code).toBe('context_length_exceeded');

    const key = make(() => new Response(html, { status: 524 }));
    const keyErr = await caught(key.provider.validateKey('sk-or-v1-abc'));
    expect(keyErr.message).toBe(ERROR_DEFAULTS.provider_error.message);
  });

  it('provider_error messages carry the upstream detail, without stack traces', async () => {
    const { provider } = make(() => jsonResponse(502, { error: { code: 502, message: 'Provider returned error' } }));
    const err = await caught(collect(provider));
    expect(err.message).toBe('The model provider returned an error: Provider returned error');
  });

  // ── F3: reasoning effort errors ──
  it('"Reasoning is mandatory" (400) → invalid_request with the effort hint, not retryable', async () => {
    const { provider } = make(() =>
      jsonResponse(400, {
        error: { code: 400, message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' },
      }),
    );
    const err = await caught(collect(provider, { ...REQ, effort: 'none' }));
    expect(err.code).toBe('invalid_request');
    expect(err.message).toBe("This model can't turn reasoning off. Pick another effort.");
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(400);
  });

  it('a different 400 that mentions reasoning keeps its own message, not the effort hint', async () => {
    const { provider } = make(() =>
      jsonResponse(400, { error: { code: 400, message: 'Invalid reasoning.effort value for this model.' } }),
    );
    const err = await caught(collect(provider, { ...REQ, effort: 'low' }));
    expect(err.code).toBe('invalid_request');
    expect(err.message).toBe('Invalid reasoning.effort value for this model.');
    expect(err.message).not.toBe("This model can't turn reasoning off. Pick another effort.");
  });
});

// ── S2.6: abort ────────────────────────────────────────────────────────────────────────────────

describe('abort', () => {
  it('passes the signal to fetch and propagates an abort mid-stream untouched', async () => {
    const ac = new AbortController();
    let received: AbortSignal | null | undefined;
    const { provider } = make((call) => {
      received = call.init.signal;
      const signal = call.init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
          signal.addEventListener('abort', () => c.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });
    const seen: ProviderEvent[] = [];
    const run = (async () => {
      for await (const e of provider.stream(REQ, ac.signal)) {
        seen.push(e);
        ac.abort();
      }
    })();
    await expect(run).rejects.toSatisfy((e) => !(e instanceof ProviderError));
    expect(received).toBe(ac.signal);
    expect(seen).toEqual([{ type: 'text_delta', delta: 'hi' }]);
  });

  it('a fetch rejected by abort is not reported as network_error', async () => {
    const ac = new AbortController();
    const { provider } = make((call) => {
      ac.abort();
      throw (call.init.signal as AbortSignal).reason;
    });
    await expect(collect(provider, REQ, ac.signal)).rejects.toSatisfy((e) => !(e instanceof ProviderError));
  });
});

// ── S2.7: reasoning_details ────────────────────────────────────────────────────────────────────

describe('reasoning_details', () => {
  const merged = [
    {
      type: 'reasoning.text',
      text: 'The user wants the README.',
      signature: 'EqQBCkYIBxgCIkAsig==',
      id: 'reasoning-text-1',
      format: 'anthropic-claude-v1',
      index: 0,
    },
    {
      type: 'reasoning.encrypted',
      data: '[REDACTED]',
      id: 'reasoning-encrypted-2',
      format: 'anthropic-claude-v1',
      index: 1,
    },
  ];

  it('collects streamed fragments into exactly one meta event, before the tool call', async () => {
    const { provider } = make(() => sseResponse(fixture('reasoning-tool-call.sse'), 11));
    const events = await collect(provider);
    expect(events).toEqual([
      { type: 'meta', providerMeta: merged },
      { type: 'tool_call', call: { id: 'toolu_01', name: 'read_file', argsJson: '{"path":"README.md"}' } },
      { type: 'usage', usage: { promptTokens: 300, completionTokens: 80 } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
    expect(events.filter((e) => e.type === 'meta')).toHaveLength(1);
  });

  it('emits no meta when the model sent no reasoning', async () => {
    const events = await collect(make(() => sseResponse(fixture('text-stream.sse'))).provider);
    expect(events.some((e) => e.type === 'meta')).toBe(false);
  });

  it('sends providerMeta back as reasoning_details on the assistant message', async () => {
    const { provider, calls } = make(() => sseResponse(fixture('text-stream.sse')));
    await collect(provider, {
      ...REQ,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'toolu_01', name: 'read_file', argsJson: '{"path":"README.md"}' }],
          providerMeta: merged,
        },
        { role: 'tool', toolCallId: 'toolu_01', content: '# readme' },
        { role: 'assistant', text: 'ok', toolCalls: [], providerMeta: { not: 'an array' } },
      ],
    });
    const msgs = calls[0]?.body.messages;
    expect(msgs[2].reasoning_details).toEqual(merged);
    expect(msgs[2].tool_calls).toHaveLength(1);
    expect(msgs[4]).toEqual({ role: 'assistant', content: 'ok' }); // non-array meta is never sent
  });
});

// ── S2.8: validateKey ──────────────────────────────────────────────────────────────────────────

describe('validateKey', () => {
  it('GETs /key with the given key and resolves on 2xx', async () => {
    const { provider, calls } = make(() => jsonResponse(200, { data: { label: 'sk-or-v1-abc', usage: 0 } }), null);
    await expect(provider.validateKey('sk-or-v1-candidate')).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/key');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.headers.Authorization).toBe('Bearer sk-or-v1-candidate');
  });

  it.each([401, 403])('%i → invalid_api_key', async (status) => {
    const { provider } = make(() => jsonResponse(status, { error: { code: status, message: 'nope' } }));
    const err = await caught(provider.validateKey('bad'));
    expect(err.code).toBe('invalid_api_key');
  });

  it('maps other failures like everywhere else', async () => {
    expect(
      (await caught(make(() => jsonResponse(429, { error: { code: 429, message: 'x' } })).provider.validateKey('k')))
        .code,
    ).toBe('rate_limited');
    expect(
      (await caught(make(() => jsonResponse(503, { error: { code: 503, message: 'x' } })).provider.validateKey('k')))
        .code,
    ).toBe('provider_error');
    const down = make(() => {
      throw new TypeError('fetch failed');
    });
    expect((await caught(down.provider.validateKey('k'))).code).toBe('network_error');
  });

  it.each([
    ['a line break', 'sk-or-v1-abc\ndef'],
    ['a space', 'sk-or-v1-abc def'],
    ['a zero-width space', 'sk-or-v1-abc\u200bdef'],
    ['a non-ASCII letter', 'sk-or-v1-abcédef'],
    ['a tab', 'sk-or-v1-abc\tdef'],
    ['nothing', ''],
  ])('rejects a key containing %s as invalid_api_key without calling fetch', async (_, bad) => {
    const { provider, calls } = make(() => jsonResponse(200, {}));
    const err = await caught(provider.validateKey(bad));
    expect(err.code).toBe('invalid_api_key');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('This key contains spaces or invalid characters.');
    expect(calls).toHaveLength(0);
  });

  it('never echoes the key or the raw fetch error', async () => {
    const secret = 'sk-or-v1-secretsecret';
    const { provider } = make(() => {
      throw new TypeError(`Headers.append: "Bearer ${secret}" is an invalid header value.`);
    });
    const err = await caught(provider.validateKey(secret));
    expect(err.code).toBe('network_error');
    expect(err.message).toBe(ERROR_DEFAULTS.network_error.message);
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(String(err.stack)).not.toContain(secret);
  });
});

// ── S2.9: listModels ───────────────────────────────────────────────────────────────────────────

describe('listModels', () => {
  const models = JSON.parse(fixture('models.json'));

  it('GETs /models with the key and maps to ModelInfo', async () => {
    const { provider, calls } = make(() => jsonResponse(200, models));
    const list = await provider.listModels();
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/models');
    expect(calls[0]?.headers.Authorization).toBe('Bearer sk-or-v1-test');
    expect(list.map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-4.5',
      'deepseek/deepseek-chat-v3.1',
      'google/gemini-2.5-flash-image', // outputs image AND text → kept
      'openrouter/auto',
      'meta-llama/llama-3.3-70b-instruct:free',
    ]); // flux-pro (image output only) dropped
    expect(list[0]).toEqual({
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Anthropic: Claude Sonnet 4.5',
      author: 'Anthropic',
      contextLength: 1000000,
      supportsTools: true,
      supportsImages: true,
      supportsReasoning: true,
      promptPricePerMTok: 3,
      completionPricePerMTok: 15,
    });
  });

  it('derives capabilities, pricing and context length defensively', () => {
    const list = mapModels(models.data);
    const byId = Object.fromEntries(list.map((m) => [m.id, m]));
    expect(byId['deepseek/deepseek-chat-v3.1']).toMatchObject({
      supportsTools: true,
      supportsImages: false,
      promptPricePerMTok: 0.2,
      completionPricePerMTok: 0.8,
    });
    expect(byId['google/gemini-2.5-flash-image']).toMatchObject({ supportsTools: false, supportsImages: true });
    // router pseudo-price "-1" → unknown, not a negative price
    expect(byId['openrouter/auto']).toMatchObject({ promptPricePerMTok: null, completionPricePerMTok: null });
    // missing context_length falls back to top_provider.context_length; free models price 0
    expect(byId['meta-llama/llama-3.3-70b-instruct:free']).toMatchObject({
      contextLength: 65536,
      promptPricePerMTok: 0,
      completionPricePerMTok: 0,
    });
  });

  // ── F3: supportsReasoning comes from supported_parameters ──
  it('mapModels sets supportsReasoning from "reasoning" in supported_parameters', () => {
    const byId = Object.fromEntries(mapModels(models.data).map((m) => [m.id, m]));
    expect(byId['anthropic/claude-sonnet-4.5']?.supportsReasoning).toBe(true);
    expect(byId['deepseek/deepseek-chat-v3.1']?.supportsReasoning).toBe(false);
    // Lists tools and max_tokens but not reasoning.
    expect(byId['openrouter/auto']?.supportsReasoning).toBe(false);
  });

  // ── F3 follow-up: per-model effort levels ──
  it('mapModels sorts supported_efforts ascending, dedupes and drops unknown levels', () => {
    const [m] = mapModels([
      {
        id: 'a/b',
        name: 'B',
        architecture: {},
        reasoning: { supported_efforts: ['max', 'high', 'bogus', 'low', 'high'], default_effort: 'high' },
      },
    ]);
    expect(m?.reasoningEfforts).toEqual(['low', 'high', 'max']);
    expect(m?.defaultEffort).toBe('high');
  });

  it('mapModels omits empty/absent efforts and an unknown default_effort', () => {
    const [empty, absent, badDefault] = mapModels([
      { id: 'a/empty', name: 'Empty', architecture: {}, reasoning: { supported_efforts: [] } },
      { id: 'a/absent', name: 'Absent', architecture: {} },
      {
        id: 'a/bad-default',
        name: 'Bad default',
        architecture: {},
        reasoning: { supported_efforts: ['none', 'max'], default_effort: 'ultra' },
      },
    ]);
    expect(empty).not.toHaveProperty('reasoningEfforts');
    expect(absent).not.toHaveProperty('reasoningEfforts');
    expect(badDefault?.reasoningEfforts).toEqual(['none', 'max']);
    expect(badDefault).not.toHaveProperty('defaultEffort');
  });

  it('does not produce float noise when scaling prices', () => {
    const [m] = mapModels([
      { id: 'a/b', name: 'B', pricing: { prompt: '0.000001', completion: '0.00000015' }, architecture: {} },
    ]);
    expect(m?.promptPricePerMTok).toBe(1);
    expect(m?.completionPricePerMTok).toBe(0.15);
  });

  it('errors: no key, HTTP failure and malformed body', async () => {
    expect((await caught(make(() => jsonResponse(200, models), null).provider.listModels())).code).toBe('no_api_key');
    expect(
      (await caught(make(() => jsonResponse(401, { error: { code: 401, message: 'x' } })).provider.listModels())).code,
    ).toBe('invalid_api_key');
    expect((await caught(make(() => jsonResponse(200, { nope: true })).provider.listModels())).code).toBe(
      'provider_error',
    );
    expect((await caught(make(() => new Response('<html>', { status: 200 })).provider.listModels())).code).toBe(
      'provider_error',
    );
  });
});

describe('mapModels identity fields', () => {
  it('maps description, author from the name, and falls back to the slug map', () => {
    const [a, b, c] = mapModels([
      { id: 'deepseek/x', name: 'DeepSeek: X', description: 'Good at code.' },
      { id: 'qwen/y', name: 'y' },
      { id: 'acme/z', name: 'z', description: '  ' },
    ]);
    expect(a).toMatchObject({ author: 'DeepSeek', description: 'Good at code.' });
    expect(b?.author).toBe('Alibaba (Qwen)');
    expect(c?.author).toBe('acme');
    expect(c).not.toHaveProperty('description');
  });
});
