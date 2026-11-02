// Streaming route tests (S5.4/S5.8): event order, pre-stream validation, disconnect = stop, 409, retry.

import type { AgentEvent } from '@shared/events';
import type { AttachmentRef, Chat, Project } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../core/providers/fake';
import { collectEvents, createHarness, type Harness, PNG_BYTES, shape, uploadForm, waitFor } from './test-helpers';

const VISION = 'anthropic/claude-sonnet-5.5';
const NO_VISION = 'deepseek/deepseek-v3.2';

/** First call: some text, then a long pause (aborted by the test). Later calls: a quick answer. */
const slowScript: FakeScript = () => [
  { type: 'text_delta', delta: 'partial ' },
  { type: 'text_delta', delta: 'reply' },
  { type: 'delay', ms: 30_000 },
  { type: 'finish', reason: 'stop' },
];

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

async function newChat(projectId: string | null = null, model = VISION): Promise<Chat> {
  const res = await h.call('/api/chats', { method: 'POST', json: { projectId, model } });
  return (await res.json()) as Chat;
}
async function newProject(): Promise<Project> {
  const res = await h.call('/api/projects', { method: 'POST', json: { rootPath: h.projectDir } });
  return (await res.json()) as Project;
}
const send = (chatId: string, json: unknown, init: RequestInit = {}) =>
  h.call(`/api/chats/${chatId}/messages`, { method: 'POST', json, ...init });
const lastMessage = async (chatId: string) => (await h.core.chats.get(chatId)).messages.at(-1);

/** Reads until the decoded stream text matches, returning the reader for the caller to cancel. */
async function readUntil(res: Response, pattern: RegExp) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!pattern.test(text)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream ended before ${pattern}: ${text}`);
    text += decoder.decode(value, { stream: true });
  }
  return { reader, text };
}

describe('POST /api/chats/:id/messages', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('streams a full tool turn in a project chat in the §4.4 order', async () => {
    const project = await newProject();
    const chat = await newChat(project.id);
    const res = await send(chat.id, { text: 'What does the README say?', attachmentIds: [], model: VISION });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');

    const events = await collectEvents(res);
    const types = shape(events);
    expect(types.slice(0, 9)).toEqual([
      'user_message',
      'assistant_start',
      'text_delta',
      'assistant_end',
      'tool_call',
      'tool_result',
      'assistant_start',
      'text_delta',
      'assistant_end',
    ]);
    expect(types.slice(9).every((t) => t === 'chat_updated' || t === 'done')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });

    const toolResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    expect(toolResult?.message).toMatchObject({ name: 'read_file', ok: true });
    expect(toolResult?.message.output).toContain('Hello from the README.');

    const persisted = await h.core.chats.get(chat.id);
    expect(persisted.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('writes plain `data:` frames (no event/id fields), an initial comment, and closes after done', async () => {
    const chat = await newChat();
    const res = await send(chat.id, { text: 'hi', attachmentIds: [], model: VISION });
    const text = await res.text();
    expect(text.startsWith(': ok\n\n')).toBe(true);
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines.filter((l) => !l.startsWith('data: ') && !l.startsWith(':'))).toEqual([]);
    expect(lines.at(-1)).toBe('data: {"type":"done"}');
  });

  it('loose chat: text only, no tool events', async () => {
    const chat = await newChat();
    const events = await collectEvents(await send(chat.id, { text: 'hi', attachmentIds: [], model: VISION }));
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(shape(events)[0]).toBe('user_message');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('validates before opening the stream: JSON errors with proper statuses', async () => {
    const chat = await newChat();
    const expectJsonError = async (res: Response, status: number, code: string) => {
      expect(res.status).toBe(status);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    };
    await expectJsonError(await send('nope', { text: 'x', attachmentIds: [], model: VISION }), 404, 'not_found');
    await expectJsonError(
      await send(chat.id, { text: '  ', attachmentIds: [], model: VISION }),
      400,
      'invalid_request',
    );
    await expectJsonError(await send(chat.id, { text: 'x', attachmentIds: [], model: '' }), 400, 'invalid_request');
    await expectJsonError(
      await send(chat.id, { text: 'x', attachmentIds: ['missing'], model: VISION }),
      404,
      'not_found',
    );
    const tooMany = Array.from({ length: 11 }, (_, i) => `a${i}`);
    await expectJsonError(
      await send(chat.id, { text: 'x', attachmentIds: tooMany, model: VISION }),
      400,
      'invalid_request',
    );
    expect((await h.core.chats.get(chat.id)).messages).toEqual([]); // nothing persisted by failed requests
  });

  it('rejects an attachment bound to another chat with 409', async () => {
    const a = await newChat();
    const b = await newChat();
    const ref = (await (
      await h.call('/api/attachments', { method: 'POST', body: uploadForm('x', 'a.txt') })
    ).json()) as AttachmentRef;
    await h.core.attachments.bindToChat([ref.id], a.id);
    const res = await send(b.id, { text: 'x', attachmentIds: [ref.id], model: VISION });
    expect(res.status).toBe(409);
  });

  it('image + non-vision model → 400 model_no_image_input; vision model is fine', async () => {
    const chat = await newChat();
    const img = (await (
      await h.call('/api/attachments', { method: 'POST', body: uploadForm(PNG_BYTES, 'p.png') })
    ).json()) as AttachmentRef;
    const bad = await send(chat.id, { text: 'look', attachmentIds: [img.id], model: NO_VISION });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('model_no_image_input');
    expect(h.core.agent.isRunning(chat.id)).toBe(false);

    const ok = await collectEvents(await send(chat.id, { text: 'look', attachmentIds: [img.id], model: VISION }));
    const user = ok.find((e) => e.type === 'user_message');
    expect(user?.type === 'user_message' && user.message.attachments[0]?.id).toBe(img.id);
  });

  it('text attachments work with any model', async () => {
    const chat = await newChat();
    const txt = (await (
      await h.call('/api/attachments', { method: 'POST', body: uploadForm('some notes', 'n.txt') })
    ).json()) as AttachmentRef;
    const events = await collectEvents(
      await send(chat.id, { text: 'read', attachmentIds: [txt.id], model: NO_VISION }),
    );
    expect(events.at(-1)?.type).toBe('done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('409 conflict while a run is active (and the run is unaffected)', async () => {
    h = await replaceHarness(slowScript);
    const chat = await newChat();
    const first = await send(chat.id, { text: 'go', attachmentIds: [], model: VISION });
    const { reader } = await readUntil(first, /text_delta/);
    expect(h.core.agent.isRunning(chat.id)).toBe(true);

    const second = await send(chat.id, { text: 'again', attachmentIds: [], model: VISION });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('conflict');
    const retry = await h.call(`/api/chats/${chat.id}/retry`, { method: 'POST', json: { model: VISION } });
    expect(retry.status).toBe(409);

    await reader.cancel();
    await waitFor(() => !h.core.agent.isRunning(chat.id));
  });

  it('two simultaneous requests: exactly one starts, the other gets 409', async () => {
    h = await replaceHarness(slowScript);
    const chat = await newChat();
    const body = { text: 'go', attachmentIds: [], model: VISION };
    const [a, b] = await Promise.all([send(chat.id, body), send(chat.id, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const { reader } = await readUntil(winner, /text_delta/);
    await reader.cancel();
    await waitFor(() => !h.core.agent.isRunning(chat.id));
  });

  it('client disconnect (response body cancelled — the Electron path) saves the reply as stopped', async () => {
    h = await replaceHarness(slowScript);
    const chat = await newChat();
    const res = await send(chat.id, { text: 'go', attachmentIds: [], model: VISION });
    const { reader } = await readUntil(res, /"reply"/);
    await reader.cancel();
    await waitFor(() => !h.core.agent.isRunning(chat.id));

    const last = await lastMessage(chat.id);
    expect(last).toMatchObject({ role: 'assistant', status: 'stopped', text: 'partial reply' });
  });

  it('client disconnect (request signal aborted — the Node path) saves the reply as stopped', async () => {
    h = await replaceHarness(slowScript);
    const chat = await newChat();
    const controller = new AbortController();
    const res = await send(chat.id, { text: 'go', attachmentIds: [], model: VISION }, { signal: controller.signal });
    const { reader } = await readUntil(res, /"reply"/);
    controller.abort(); // only the request signal; the response body is deliberately not cancelled
    void (async () => {
      for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) break;
    })();
    await waitFor(() => !h.core.agent.isRunning(chat.id));

    expect(await lastMessage(chat.id)).toMatchObject({ role: 'assistant', status: 'stopped' });
  });

  it('DELETE /api/chats/:id aborts an active run, then removes the chat and its attachments', async () => {
    h = await replaceHarness(slowScript);
    const chat = await newChat();
    const ref = (await (
      await h.call('/api/attachments', { method: 'POST', body: uploadForm('x', 'a.txt') })
    ).json()) as AttachmentRef;
    const res = await send(chat.id, { text: 'go', attachmentIds: [ref.id], model: VISION });
    const { reader } = await readUntil(res, /"reply"/);

    // The client keeps reading (as the real UI does) so the agent can flush `assistant_end` / `done`.
    const delPromise = h.call(`/api/chats/${chat.id}`, { method: 'DELETE' });
    let rest = '';
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    expect(rest).toContain('"status":"stopped"');
    const del = await delPromise;
    expect(del.status).toBe(204);
    expect(h.core.agent.isRunning(chat.id)).toBe(false);
    expect((await h.call(`/api/chats/${chat.id}`)).status).toBe(404);
    expect((await h.call(`/api/attachments/${ref.id}/content`)).status).toBe(404);
  });
});

describe('POST /api/chats/:id/retry', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('drops trailing assistant/tool messages and reruns without a user_message event', async () => {
    const project = await newProject();
    const chat = await newChat(project.id);
    await collectEvents(await send(chat.id, { text: 'README?', attachmentIds: [], model: VISION }));
    expect((await h.core.chats.get(chat.id)).messages).toHaveLength(4);

    const res = await h.call(`/api/chats/${chat.id}/retry`, { method: 'POST', json: { model: VISION } });
    expect(res.status).toBe(200);
    const events = await collectEvents(res);
    expect(events[0]?.type).toBe('assistant_start');
    expect(events.some((e) => e.type === 'user_message')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
    expect((await h.core.chats.get(chat.id)).messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('errors: unknown chat 404, nothing to retry 400, bad body 400', async () => {
    const chat = await newChat();
    expect((await h.call('/api/chats/nope/retry', { method: 'POST', json: { model: VISION } })).status).toBe(404);
    expect((await h.call(`/api/chats/${chat.id}/retry`, { method: 'POST', json: { model: VISION } })).status).toBe(400);
    expect((await h.call(`/api/chats/${chat.id}/retry`, { method: 'POST', json: {} })).status).toBe(400);
  });
});

/** Swaps the test openvern for one with a custom script (cleaning up the previous one first). */
async function replaceHarness(script: FakeScript): Promise<Harness> {
  await h.cleanup();
  return createHarness({ script });
}

/** Harness whose `listModels` waits on a gate, so `models.get` (image send) stalls before `streamSSE`. */
async function gatedHarness(script: FakeScript) {
  await h.cleanup();
  let entered!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    open = r;
  });
  h = await createHarness({
    script,
    wrapProvider: (fake) => ({
      ...fake,
      id: 'fake',
      listModels: async () => {
        entered();
        await gate;
        return fake.listModels();
      },
      validateKey: fake.validateKey,
      stream: fake.stream,
    }),
  });
  return { reached, open };
}

/** Sends once more and checks the chat is not stuck on 409; the reply is not collected, just cancelled. */
async function expectNextSendOk(chatId: string) {
  const next = await send(chatId, { text: 'again', attachmentIds: [], model: VISION });
  expect(next.status).toBe(200);
  const { reader } = await readUntil(next, /"reply"/);
  await reader.cancel();
  await waitFor(() => !h.core.agent.isRunning(chatId));
}

describe('disconnect before the stream opens (S5-M1)', () => {
  it('abort during pre-stream validation: run never starts, nothing saved, next send 200', async () => {
    h = await createHarness();
    const { reached, open } = await gatedHarness(slowScript);
    const chat = await newChat();
    const img = (await (
      await h.call('/api/attachments', { method: 'POST', body: uploadForm(PNG_BYTES, 'p.png') })
    ).json()) as AttachmentRef;
    const ac = new AbortController();
    const p = send(chat.id, { text: 'go', attachmentIds: [img.id], model: VISION }, { signal: ac.signal });
    await reached;
    ac.abort();
    open();
    await p; // deliberately neither read nor cancelled: cancelling would fire stream.onAbort and hide the bug
    await new Promise((r) => setTimeout(r, 100));

    expect(h.core.agent.isRunning(chat.id)).toBe(false);
    expect((await h.core.chats.get(chat.id)).messages).toEqual([]);
    expect((await h.core.attachments.get(img.id)).chatId).toBeNull();
    await expectNextSendOk(chat.id);
  }, 10_000);

  it('already-aborted signal on send: no run, no message', async () => {
    h = await replaceHarness(slowScript);
    const chat = await newChat();
    const ac = new AbortController();
    ac.abort();
    const res = await send(chat.id, { text: 'go', attachmentIds: [], model: VISION }, { signal: ac.signal }).catch(
      () => null,
    );
    if (res) expect([200, 400, 499]).toContain(res.status);
    await new Promise((r) => setTimeout(r, 100));

    expect(h.core.agent.isRunning(chat.id)).toBe(false);
    expect((await h.core.chats.get(chat.id)).messages).toEqual([]);
    await expectNextSendOk(chat.id);
  }, 10_000);

  it('retry with an already-aborted signal: no run, no truncation', async () => {
    h = await createHarness();
    const chat = await newChat();
    await collectEvents(await send(chat.id, { text: 'hi', attachmentIds: [], model: VISION }));
    const before = (await h.core.chats.get(chat.id)).messages.map((m) => m.id);
    expect(before).toHaveLength(2);

    const ac = new AbortController();
    ac.abort();
    await h
      .call(`/api/chats/${chat.id}/retry`, { method: 'POST', json: { model: VISION }, signal: ac.signal })
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 100));

    expect(h.core.agent.isRunning(chat.id)).toBe(false);
    expect((await h.core.chats.get(chat.id)).messages.map((m) => m.id)).toEqual(before);
    const again = await h.call(`/api/chats/${chat.id}/retry`, { method: 'POST', json: { model: VISION } });
    expect(again.status).toBe(200);
    await collectEvents(again);
  }, 10_000);
});
