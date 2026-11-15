// POST /api/chats/:id/terminal-reads/:requestId (terminal plan §4.2, T2.5). The body carries terminal text bound for
// the model, so the route validates it, and everything that is not a request still waiting under this chat is the same
// 404 (no answer may touch another chat's waiter, and no response may reveal that one exists).

import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@shared/constants';
import type { AgentEvent } from '@shared/events';
import { TERMINAL, type TerminalReadAnswer, type TerminalReadRequest } from '@shared/terminal';
import type { Chat } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectEvents, createHarness, type Harness } from './test-helpers';

const MODEL = 'anthropic/claude-sonnet-5.5';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  vi.useRealTimers();
  await h.cleanup();
});

const json = async <T>(res: Response) => (await res.json()) as T;
const newChat = async (projectId: string | null = null) =>
  json<Chat>(await h.call('/api/chats', { method: 'POST', json: { projectId, model: MODEL } }));

function answer(text = 'hello from the terminal\n'): TerminalReadAnswer {
  // `chatId` is validated as an id, not against the route's chat: the broker does the matching.
  return {
    ok: true,
    result: {
      info: { chatId: 'chat-1', shell: 'zsh', cwd: '/home/me/demo', cols: 120, rows: 30, status: { state: 'running' } },
      totalLines: 2,
      startLine: 1,
      endLine: 2,
      text,
      truncated: false,
    },
  };
}

/** The successful half of `answer()`, for building malformed variants. */
const successResult = () => {
  const body = answer();
  if (!body.ok) throw new Error('unreachable');
  return body.result;
};

interface Waiting {
  requestId: string;
  settled: Promise<TerminalReadAnswer>;
}

/** Starts a real broker request and returns after the `terminal_read_request` event has gone out. */
async function waitForAnswer(chatId: string, request: TerminalReadRequest = {}): Promise<Waiting> {
  let requestId: string | undefined;
  const settled = h.core.terminalReads.request(chatId, request, {
    emit: (event) => {
      if (event.type === 'terminal_read_request') requestId = event.requestId;
    },
    signal: new AbortController().signal,
  });
  await Promise.resolve();
  if (!requestId) throw new Error('the request was not emitted');
  return { requestId, settled };
}

const answerUrl = (chatId: string, requestId: string) => `/api/chats/${chatId}/terminal-reads/${requestId}`;
const postAnswer = (chatId: string, requestId: string, body: unknown) =>
  h.call(answerUrl(chatId, requestId), { method: 'POST', json: body });

describe('POST /api/chats/:id/terminal-reads/:requestId', () => {
  it('204 when a waiting request took the answer, and the broker resolves with it', async () => {
    const chat = await newChat();
    const waiting = await waitForAnswer(chat.id, { startLine: 10, count: 20 });
    const body = answer();

    const res = await postAnswer(chat.id, waiting.requestId, body);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    await expect(waiting.settled).resolves.toEqual(body);
  });

  it('204 for a no_terminal answer too', async () => {
    const chat = await newChat();
    const waiting = await waitForAnswer(chat.id);

    expect((await postAnswer(chat.id, waiting.requestId, { ok: false, reason: 'no_terminal' })).status).toBe(204);
    await expect(waiting.settled).resolves.toEqual({ ok: false, reason: 'no_terminal' });
  });

  it('404 for an unknown request id', async () => {
    const chat = await newChat();

    const res = await postAnswer(chat.id, crypto.randomUUID(), answer());
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('not_found');
  });

  it('404 once the request has expired', async () => {
    const chat = await newChat();

    vi.useFakeTimers();
    const waiting = await waitForAnswer(chat.id);
    await vi.advanceTimersByTimeAsync(TERMINAL.readTimeoutMs);
    await expect(waiting.settled).resolves.toEqual({ ok: false, reason: 'unavailable' });
    vi.useRealTimers();

    expect((await postAnswer(chat.id, waiting.requestId, answer())).status).toBe(404);
  });

  it('404 for a repeated answer', async () => {
    const chat = await newChat();
    const waiting = await waitForAnswer(chat.id);

    expect((await postAnswer(chat.id, waiting.requestId, answer())).status).toBe(204);
    expect((await postAnswer(chat.id, waiting.requestId, answer('again'))).status).toBe(404);
    await expect(waiting.settled).resolves.toEqual(answer());
  });

  it("404 for another chat's request id, and the real waiter is still waiting", async () => {
    const chat = await newChat();
    const other = await newChat();
    const waiting = await waitForAnswer(chat.id);

    const refused = await postAnswer(other.id, waiting.requestId, answer());
    expect(refused.status).toBe(404);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe('not_found');

    // Nothing settled the real waiter: its own route still takes the answer.
    expect((await postAnswer(chat.id, waiting.requestId, answer())).status).toBe(204);
    await expect(waiting.settled).resolves.toEqual(answer());
  });

  it.each([
    ['an empty object', {}],
    ['a missing result', { ok: true }],
    ['an unknown reason', { ok: false, reason: 'timeout' }],
    ['an out-of-range line number', { ok: true, result: { ...successResult(), endLine: 99_999 } }],
    ['a negative line number', { ok: true, result: { ...successResult(), startLine: -1 } }],
    ['a wrong type', { ok: 'yes' }],
  ])('400 for a malformed body: %s', async (_name, body) => {
    const chat = await newChat();
    const waiting = await waitForAnswer(chat.id);

    const res = await postAnswer(chat.id, waiting.requestId, body);
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('invalid_request');
    // The waiter is untouched and still takes its real answer.
    expect((await postAnswer(chat.id, waiting.requestId, answer())).status).toBe(204);
    await expect(waiting.settled).resolves.toEqual(answer());
  });

  it('400 for a body that is not JSON', async () => {
    const chat = await newChat();
    const waiting = await waitForAnswer(chat.id);

    const res = await h.app.request(answerUrl(chat.id, waiting.requestId), {
      method: 'POST',
      headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, 'Content-Type': 'application/json' },
      body: '{"ok":',
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('invalid_request');
    expect((await postAnswer(chat.id, waiting.requestId, answer())).status).toBe(204);
  });

  it('400 for oversized text', async () => {
    const chat = await newChat();
    const waiting = await waitForAnswer(chat.id);

    const res = await postAnswer(chat.id, waiting.requestId, answer('x'.repeat(2 * TERMINAL.readMaxBytes + 1)));
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('invalid_request');
    // The size the contract allows still passes.
    expect((await postAnswer(chat.id, waiting.requestId, answer('x'.repeat(2 * TERMINAL.readMaxBytes)))).status).toBe(
      204,
    );
  });

  it('403 without the client header', async () => {
    const chat = await newChat();
    const waiting = await waitForAnswer(chat.id);

    const res = await h.app.request(answerUrl(chat.id, waiting.requestId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(answer()),
    });
    expect(res.status).toBe(403);
    // The waiter is still there for the real client.
    expect((await postAnswer(chat.id, waiting.requestId, answer())).status).toBe(204);
    await expect(waiting.settled).resolves.toEqual(answer());
  });
});

describe('terminal: true on the send route', () => {
  const send = (chatId: string, text: string, terminal?: boolean) =>
    h.call(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      json: { text, attachmentIds: [], model: MODEL, ...(terminal ? { terminal: true } : {}) },
    });
  const frames = (sse: string): AgentEvent[] =>
    sse
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as AgentEvent);

  it('relays a read from the stream and posts the answer back to the same request', async () => {
    const chat = await newChat();
    const res = await send(chat.id, '[fake:terminal]', true);
    expect(res.status).toBe(200);

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let sse = '';
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(sse)) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`the stream ended before ${pattern}: ${sse}`);
        sse += decoder.decode(value, { stream: true });
      }
    };

    await readUntil(/"type":"terminal_read_request"/);
    const requestId = /"requestId":"([^"]+)"/.exec(sse)?.[1];
    expect(requestId).toBeTruthy();
    const toolText = 'echo hello-term\nhello-term';
    expect((await postAnswer(chat.id, requestId as string, answer(toolText))).status).toBe(204);

    await readUntil(/"type":"done"/);
    await reader.cancel();

    const events = frames(sse);
    const requests = events.filter(
      (e): e is Extract<AgentEvent, { type: 'terminal_read_request' }> => e.type === 'terminal_read_request',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.requestId).toBe(requestId);
    expect(requests[0]?.request).toEqual({});
    const result = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    expect(result?.message).toMatchObject({ name: 'read_terminal', ok: true, toolCallId: expect.any(String) });
    expect(result?.message.output).toContain('hello-term');
    expect(events.at(-1)).toEqual({ type: 'done' });
    // The fake model repeats the result's first line, so the answer is visible in the reply.
    const assistant = events.filter(
      (e): e is Extract<AgentEvent, { type: 'assistant_end' }> => e.type === 'assistant_end',
    );
    expect(assistant.at(-1)?.message.text).toContain('Terminal: zsh');
  });

  it('offers no read_terminal without the flag, so no request is emitted', async () => {
    const chat = await newChat();
    const events = await collectEvents(await send(chat.id, '[fake:terminal]'));
    expect(events.some((e) => e.type === 'terminal_read_request')).toBe(false);
    expect(events.some((e) => e.type === 'tool_call' && e.toolCall.name === 'read_terminal')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });
});
