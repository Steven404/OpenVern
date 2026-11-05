// F2 (plan §6): archiving chats that live in a project. The PATCH guard is high risk because it shares the
// run claim with the streaming routes, so these tests hold a real claim, not only a mocked `isRunning`.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Chat, ChatSummary, PendingChanges, Project } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../core/providers/fake';
import type { AgentService } from '../core/types';
import { createHarness, type Harness, PNG_BYTES, uploadForm, waitFor } from './test-helpers';

const VISION = 'anthropic/claude-sonnet-5.5';
const WAIT = 'Wait for the response to finish before archiving or unarchiving this chat.';
const PENDING = 'Apply or discard the proposed edits first.';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.cleanup();
});

const json = async <T>(res: Response) => (await res.json()) as T;
const newProject = async (rootPath = h.projectDir) =>
  json<Project>(await h.call('/api/projects', { method: 'POST', json: { rootPath } }));
const newChat = async (projectId: string | null) =>
  json<Chat>(await h.call('/api/chats', { method: 'POST', json: { projectId, model: VISION } }));
const patch = (chatId: string, body: unknown) => h.call(`/api/chats/${chatId}`, { method: 'PATCH', json: body });
const stored = async (chatId: string) => json<Chat>(await h.call(`/api/chats/${chatId}`));
const send = (chatId: string, body: unknown, init: RequestInit = {}) =>
  h.call(`/api/chats/${chatId}/messages`, { method: 'POST', json: body, ...init });
const pending = (revision = 1): PendingChanges => ({
  revision,
  messageId: 'm1',
  files: [
    {
      path: 'src/a.ts',
      kind: 'modify',
      add: 1,
      del: 1,
      hunks: [
        { id: '1:abcdef12', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '', lines: ['-a', '+b'] },
      ],
    },
  ],
  totalAdd: 1,
  totalDel: 1,
});

/** Streams a bit, pauses long enough for the test to PATCH, then finishes normally. */
const pausedScript: FakeScript = () => [
  { type: 'text_delta', delta: 'partial ' },
  { type: 'text_delta', delta: 'reply' },
  { type: 'delay', ms: 400 },
  { type: 'finish', reason: 'stop' },
];

/** Reads until the decoded stream text matches, returning the reader for the caller to finish. */
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

/** Swaps the harness for one with a custom script (cleaning up the previous one first). */
async function replaceHarness(script: FakeScript): Promise<Harness> {
  await h.cleanup();
  return createHarness({ script });
}

/** Harness whose `listModels` stalls, so a send is stuck between `claim()` and `streamTurn()`. */
async function gatedHarness() {
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

describe('PATCH /api/chats/:id while a project chat is running', () => {
  it('archiving a running project chat is a conflict and leaves the chat untouched', async () => {
    h = await replaceHarness(pausedScript);
    const project = await newProject();
    const chat = await newChat(project.id);
    const res = await send(chat.id, { text: 'go', attachmentIds: [], model: VISION });
    const { reader, text: seen } = await readUntil(res, /text_delta/);
    expect(h.core.agent.isRunning(chat.id)).toBe(true);

    const rejected = await patch(chat.id, { archived: true });
    expect(rejected.status).toBe(409);
    expect(await json<{ error: { code: string; message: string } }>(rejected)).toMatchObject({
      error: { code: 'conflict', message: WAIT },
    });
    expect(await stored(chat.id)).toMatchObject({ projectId: project.id, archived: false });

    // The rejected archive must not abort the run: read to the end and expect `done`, not `stopped`.
    let rest = seen;
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    expect(rest).toContain('"type":"done"');
    expect(rest).not.toContain('"status":"stopped"');
    expect((await h.core.chats.get(chat.id)).messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'complete',
    });
    expect((await stored(chat.id)).archived).toBe(false);

    await waitFor(() => !h.core.agent.isRunning(chat.id));
    const ok = await patch(chat.id, { archived: true });
    expect(ok.status).toBe(200);
    expect(await stored(chat.id)).toMatchObject({ projectId: project.id, archived: true });
  });

  it('archiving while a turn is starting (run claim held) is a conflict, and the claim is released', async () => {
    const { reached, open } = await gatedHarness();
    const project = await newProject();
    const chat = await newChat(project.id);
    const image = (await (
      await h.call('/api/attachments', { method: 'POST', body: uploadForm(PNG_BYTES, 'p.png') })
    ).json()) as { id: string };

    // The send claims the chat, then stalls in pre-stream validation (the model lookup).
    const controller = new AbortController();
    const starting = send(
      chat.id,
      { text: 'look', attachmentIds: [image.id], model: VISION },
      { signal: controller.signal },
    );
    await reached;
    expect(h.core.agent.isRunning(chat.id)).toBe(false); // claimed, not running yet

    const rejected = await patch(chat.id, { archived: true });
    expect(rejected.status).toBe(409);
    expect(await json<{ error: { code: string; message: string } }>(rejected)).toMatchObject({
      error: { code: 'conflict', message: WAIT },
    });
    expect(await stored(chat.id)).toMatchObject({ projectId: project.id, archived: false });

    controller.abort();
    open();
    await starting;
    await waitFor(() => !h.core.agent.isRunning(chat.id));

    // The aborted send released the claim, so the archive now goes through.
    const ok = await patch(chat.id, { archived: true });
    expect(ok.status).toBe(200);
    expect(await stored(chat.id)).toMatchObject({ projectId: project.id, archived: true });
  }, 10_000);

  it('holds the claim while archiving, so a send that starts meanwhile is a conflict', async () => {
    const project = await newProject();
    const chat = await newChat(project.id);
    const realGet = h.core.chats.get.bind(h.core.chats);
    let reads = 0;
    let claimed!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => {
      claimed = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.core.chats.get = async (id) => {
      const current = await realGet(id);
      if (id !== chat.id) return current;
      reads += 1;
      // The first read is the route's 404 snapshot; the second is the fresh read under the archive claim.
      if (reads === 2) {
        claimed();
        await gate;
      }
      return current;
    };

    const archiving = patch(chat.id, { archived: true });
    await reached;
    const during = await send(chat.id, { text: 'hi', attachmentIds: [], model: VISION });
    expect(during.status).toBe(409);
    expect(await json<{ error: { code: string; message: string } }>(during)).toMatchObject({
      error: { code: 'conflict', message: 'A response is already being generated for this chat.' },
    });

    release();
    const res = await archiving;
    expect(res.status).toBe(200);
    expect(await stored(chat.id)).toMatchObject({ projectId: project.id, archived: true });
    expect((await h.core.chats.get(chat.id)).messages).toEqual([]); // the rejected send persisted nothing
  });

  it('a move without `archived` while running still works and keeps the flag', async () => {
    const project = await newProject();
    const chat = await newChat(project.id);
    await patch(chat.id, { archived: true });
    h.core.agent = {
      runTurn: async () => {},
      isRunning: () => true,
      abort: () => {},
    } satisfies AgentService;

    const moved = await patch(chat.id, { projectId: null });
    expect(moved.status).toBe(200);
    expect(await json<ChatSummary>(moved)).toMatchObject({ projectId: null, archived: true });
    expect(await stored(chat.id)).toMatchObject({ projectId: null, archived: true });
  });
});

describe('PATCH /api/chats/:id with pending edits and the combined body', () => {
  it('archiving a project chat with pending edits succeeds and keeps the change set', async () => {
    const project = await newProject();
    const chat = await newChat(project.id);
    h.changes.seed(chat.id, pending());

    const res = await patch(chat.id, { archived: true });
    expect(res.status).toBe(200);
    expect(await json<ChatSummary>(res)).toMatchObject({ id: chat.id, projectId: project.id, archived: true });
    expect(await stored(chat.id)).toMatchObject({ projectId: project.id, archived: true });
    expect((await h.changes.get(chat.id)).pending).not.toBeNull();
  });

  it('a move with pending edits is still refused', async () => {
    const project = await newProject();
    const otherRoot = path.join(h.projectDir, 'other');
    await mkdir(otherRoot);
    const other = await newProject(otherRoot);
    const chat = await newChat(project.id);
    h.changes.seed(chat.id, pending());

    const move = await patch(chat.id, { projectId: other.id });
    expect(move.status).toBe(409);
    expect(await json<{ error: { code: string; message: string } }>(move)).toMatchObject({
      error: { code: 'conflict', message: PENDING },
    });
    expect(await stored(chat.id)).toMatchObject({ projectId: project.id, archived: false });
    expect((await h.changes.get(chat.id)).pending).not.toBeNull();
  });

  it('applies projectId and archived together to a loose chat', async () => {
    const project = await newProject();
    const chat = await newChat(null);
    expect(chat.archived).toBe(false);

    const res = await patch(chat.id, { projectId: project.id, archived: true });
    expect(res.status).toBe(200);
    expect(await json<ChatSummary>(res)).toMatchObject({ id: chat.id, projectId: project.id, archived: true });
    expect(await stored(chat.id)).toMatchObject({ projectId: project.id, archived: true });
  });
});
