// A chat's project change resets its Auto state, and every Auto batch stays in the project it was written to: a retry
// after a move can't add another project's writes to the turn's batch, and Undo never touches a file the turn didn't
// write in that project. Through the real routes, the real agent and the real change service.

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RETRY_OTHER_PROJECT, type UndoBatchResponse } from '@shared/api';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@shared/constants';
import type { AgentEvent } from '@shared/events';
import type { ChatChanges } from '@shared/types';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCore } from '../core';
import { gate } from '../core/changes/auto-test-helpers';
import { createFakeProvider, type FakeProvider } from '../core/providers/fake';
import { createFileSecretStore } from '../core/storage';
import type { Core } from '../core/types';
import { createApp } from './app';
import { collectEvents } from './test-helpers';

const MODEL = 'anthropic/claude-sonnet-5.5';
/** What the fake provider writes for `[fake:write=…]`. */
const R = '// created by the fake provider\n';

let root: string;
let core: Core;
let app: Hono;
let provider: FakeProvider;
let dirA: string;
let dirB: string;
let projectA: string;
let projectB: string;

const call = (p: string, init: { method?: string; json?: unknown } = {}) =>
  app.request(p, {
    method: init.method ?? 'GET',
    headers: {
      [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'openvern-move-reset-'));
  dirA = path.join(root, 'A');
  dirB = path.join(root, 'B');
  await mkdir(dirA);
  await mkdir(dirB);
  dirA = await realpath(dirA);
  dirB = await realpath(dirB);
  provider = createFakeProvider({ delayMs: 0 });
  core = await createCore({
    dataDir: path.join(root, 'data'),
    secretStore: createFileSecretStore(path.join(root, 'data')),
    provider,
    mode: 'dev',
    version: '9.9.9',
    homeDir: path.join(root, 'home'),
  });
  app = createApp(core, { mode: 'dev', version: '9.9.9' });
  projectA = (await core.projects.create({ rootPath: dirA })).id;
  projectB = (await core.projects.create({ rootPath: dirB })).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** An Auto chat in A whose first turn wrote `first.txt` there (the fake provider's `[fake:write=…]`). */
async function autoChatThatWroteInA(): Promise<{ chatId: string; b1: string }> {
  const created = await call('/api/chats', {
    method: 'POST',
    json: { projectId: projectA, model: MODEL, editMode: 'auto', expectedInGitRepo: false },
  });
  expect(created.status).toBe(200);
  const chatId = ((await created.json()) as { id: string }).id;
  const sent = await call(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    json: {
      text: '[fake:write=first.txt]',
      model: MODEL,
      attachmentIds: [],
      expectedEditMode: 'auto',
      expectedProjectId: projectA,
    },
  });
  expect((await collectEvents(sent)).some((e) => e.type === 'error')).toBe(false);
  expect(await readFile(path.join(dirA, 'first.txt'), 'utf8')).toBe(R);
  const changes = await getChanges(chatId);
  expect(changes.applied).toHaveLength(1);
  const b1 = changes.applied[0];
  expect(b1).toMatchObject({ source: 'auto', undoable: true });
  expect(b1?.written.map((f) => f.path)).toEqual(['first.txt']);
  return { chatId, b1: b1?.id ?? '' };
}

const getChanges = async (chatId: string) => (await (await call(`/api/chats/${chatId}/changes`)).json()) as ChatChanges;

const move = (chatId: string, from: string, to: string) =>
  call(`/api/chats/${chatId}`, {
    method: 'PATCH',
    json: { projectId: to, expectedEditMode: 'auto', expectedProjectId: from, expectedInGitRepo: false },
  });

const retry = (chatId: string, projectId: string) =>
  call(`/api/chats/${chatId}/retry`, {
    method: 'POST',
    json: { model: MODEL, expectedEditMode: 'auto', expectedProjectId: projectId },
  });

/** The retry's model: step 1 writes `result.txt` (content R), step 2 answers. */
function scriptRetryWrite() {
  let calls = 0;
  return vi.spyOn(provider, 'stream').mockImplementation(async function* () {
    calls += 1;
    if (calls === 1) {
      yield {
        type: 'tool_call',
        call: { id: 'call_result', name: 'write_file', argsJson: JSON.stringify({ path: 'result.txt', content: R }) },
      };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }
    yield { type: 'text_delta', delta: 'Done.' };
    yield { type: 'finish', reason: 'stop' };
  });
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);

describe('a retry after a move', () => {
  it('is refused while the turn’s writes are still undoable in A, and Undo in A never deletes a file it didn’t write', async () => {
    // 1. A already holds result.txt, with exactly the bytes the retry would write in B.
    await writeFile(path.join(dirA, 'result.txt'), R);
    // 2–3. The Auto turn writes first.txt in A: batch b1.
    const { chatId, b1 } = await autoChatThatWroteInA();
    // 4. The chat moves to B.
    expect((await move(chatId, projectA, projectB)).status).toBe(200);
    const before = (await core.chats.get(chatId)).messages;

    // 5. Retry in B: refused before anything is stored, undone, truncated or written.
    const stream = scriptRetryWrite();
    const events = await collectEvents(await retry(chatId, projectB));
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ code: 'conflict', message: RETRY_OTHER_PROJECT }),
    });
    for (const t of ['auto_batch_updated', 'assistant_start', 'user_message'] as const) {
      expect(types(events)).not.toContain(t);
    }
    expect(stream).not.toHaveBeenCalled();
    expect(await exists(path.join(dirB, 'result.txt'))).toBe(false);
    expect((await core.chats.get(chatId)).messages).toEqual(before);
    const afterRetry = await getChanges(chatId);
    expect(afterRetry.applied).toHaveLength(1);
    expect(afterRetry.applied[0]).toMatchObject({ id: b1 });
    expect(afterRetry.applied[0]).not.toHaveProperty('undo');

    // 6. Back in A, b1 can be undone again.
    expect((await move(chatId, projectB, projectA)).status).toBe(200);
    expect((await getChanges(chatId)).applied.find((b) => b.id === b1)?.undoable).toBe(true);

    // 7. Undo b1 restores only what the turn wrote in A.
    const undone = await call(`/api/chats/${chatId}/changes/batches/${b1}/undo`, { method: 'POST', json: {} });
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as UndoBatchResponse).batch.undo?.restored).toEqual(['first.txt']);
    expect(await exists(path.join(dirA, 'first.txt'))).toBe(false);
    expect(await readFile(path.join(dirA, 'result.txt'), 'utf8')).toBe(R);
  });

  it('once the turn’s writes in A are undone, a retry in B is allowed and writes into a new batch bound to B', async () => {
    await writeFile(path.join(dirA, 'result.txt'), R);
    const { chatId, b1 } = await autoChatThatWroteInA();
    expect((await move(chatId, projectA, projectB)).status).toBe(200);
    expect((await move(chatId, projectB, projectA)).status).toBe(200);
    const undone = await call(`/api/chats/${chatId}/changes/batches/${b1}/undo`, { method: 'POST', json: {} });
    expect(undone.status).toBe(200);
    expect((await move(chatId, projectA, projectB)).status).toBe(200);

    scriptRetryWrite();
    const events = await collectEvents(await retry(chatId, projectB));
    expect(types(events)).not.toContain('error');
    expect(await readFile(path.join(dirB, 'result.txt'), 'utf8')).toBe(R);
    const inB = await getChanges(chatId);
    expect(inB.applied).toHaveLength(2);
    const b2 = inB.applied.find((b) => b.id !== b1);
    expect(b2?.written.map((f) => f.path)).toEqual(['result.txt']);
    expect(b2?.undoable).toBe(true);

    // Back in A, the B batch can't be undone, and A's result.txt is untouched.
    expect((await move(chatId, projectB, projectA)).status).toBe(200);
    expect((await getChanges(chatId)).applied.find((b) => b.id === b2?.id)?.undoable).toBe(false);
    expect(await readFile(path.join(dirA, 'result.txt'), 'utf8')).toBe(R);
  });
});

describe('Undo rechecks the chat’s project under the store lock', () => {
  it('a move that commits after the route read the chat refuses the undo, and nothing is restored', async () => {
    const { chatId, b1 } = await autoChatThatWroteInA();
    const hold = gate();
    const realGet = core.projects.get.bind(core.projects);
    let armed = true;
    vi.spyOn(core.projects, 'get').mockImplementation(async (id) => {
      // Only the undo route's read, right after it read the chat under its claim.
      if (armed && id === projectA) {
        armed = false;
        await hold.hold();
      }
      return realGet(id);
    });
    const pending = call(`/api/chats/${chatId}/changes/batches/${b1}/undo`, { method: 'POST', json: {} });
    await hold.entered;
    try {
      expect((await move(chatId, projectA, projectB)).status).toBe(200);
    } finally {
      hold.open();
    }
    const res = await pending;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: 'conflict', message: 'These edits can no longer be undone.' },
    });
    expect(await readFile(path.join(dirA, 'first.txt'), 'utf8')).toBe(R);
    expect((await getChanges(chatId)).applied[0]).not.toHaveProperty('undo');
  });
});

describe('a retry of a turn split by a move', () => {
  const R1 = 'first attempt\n';
  const R2 = 'second write, after the move\n';

  /**
   * An Auto turn in A creates overlap.txt (R1); the chat moves to B while the turn runs; the turn, still pinned to A,
   * reads and rewrites it (R2) into a second batch. Ends with the chat moved back to A.
   */
  async function turnSplitByMove(): Promise<{ chatId: string; file: string }> {
    const created = await call('/api/chats', {
      method: 'POST',
      json: { projectId: projectA, model: MODEL, editMode: 'auto', expectedInGitRepo: false },
    });
    const chatId = ((await created.json()) as { id: string }).id;
    const hold = gate();
    let calls = 0;
    vi.spyOn(provider, 'stream').mockImplementation(async function* () {
      calls += 1;
      const tool = (id: string, name: string, args: unknown) => ({
        type: 'tool_call' as const,
        call: { id, name, argsJson: JSON.stringify(args) },
      });
      if (calls === 1) {
        // The turn creates overlap.txt in A.
        yield tool('c1', 'write_file', { path: 'overlap.txt', content: R1 });
      } else if (calls === 2) {
        // Still running and pinned to A after the move: it reads the file again and overwrites it.
        await hold.hold();
        yield tool('c2', 'read_file', { path: 'overlap.txt' });
      } else if (calls === 3) {
        yield tool('c3', 'write_file', { path: 'overlap.txt', content: R2 });
      } else {
        yield { type: 'text_delta', delta: 'Done.' };
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      yield { type: 'finish', reason: 'tool_calls' };
    });
    const sent = Promise.resolve(
      call(`/api/chats/${chatId}/messages`, {
        method: 'POST',
        json: { text: 'go', model: MODEL, attachmentIds: [], expectedEditMode: 'auto', expectedProjectId: projectA },
      }),
    ).then(collectEvents);
    await hold.entered;
    try {
      expect((await move(chatId, projectA, projectB)).status).toBe(200);
    } finally {
      hold.open();
    }
    expect(types(await sent)).not.toContain('error');
    const file = path.join(dirA, 'overlap.txt');
    expect(await readFile(file, 'utf8')).toBe(R2);
    expect(await exists(path.join(dirB, 'overlap.txt'))).toBe(false);
    // The move split the turn: two batches in A, both holding overlap.txt.
    expect((await getChanges(chatId)).applied.map((b) => b.written.map((f) => f.path))).toEqual([
      ['overlap.txt'],
      ['overlap.txt'],
    ]);
    expect((await move(chatId, projectB, projectA)).status).toBe(200);
    return { chatId, file };
  }

  it('undoes the turn’s batches newest first, so a file the pinned turn wrote twice in A goes back to missing', async () => {
    const { chatId, file } = await turnSplitByMove();
    const events = await collectEvents(await retry(chatId, projectA));
    expect(types(events)).not.toContain('error');
    // Undone in full: the file the turn created is gone, not left with the first write's bytes.
    expect(await exists(file)).toBe(false);
    const applied = (await getChanges(chatId)).applied;
    expect(applied.map((b) => b.undo)).toEqual([
      expect.objectContaining({ by: 'retry', restored: ['overlap.txt'], skipped: [] }),
      expect.objectContaining({ by: 'retry', restored: ['overlap.txt'], skipped: [] }),
    ]);
    const notice = events.find((e) => e.type === 'assistant_end');
    expect(notice).toMatchObject({ message: { notice: "Undid the previous attempt's edits (1 file)." } });
  });

  it('leaves a file the user put back to the first write’s bytes: the newer batch’s skip holds for the older one', async () => {
    const { chatId, file } = await turnSplitByMove();
    // Back in A, the user restores the first version by hand: the newer batch (R2) no longer matches, the older one
    // (R1) would.
    await writeFile(file, R1);
    const events = await collectEvents(await retry(chatId, projectA));
    expect(types(events)).not.toContain('error');
    // The user's bytes survive: no batch touched the file.
    expect(await readFile(file, 'utf8')).toBe(R1);
    const applied = (await getChanges(chatId)).applied;
    expect(applied.map((b) => b.undo)).toEqual([
      expect.objectContaining({
        by: 'retry',
        restored: [],
        skipped: [{ path: 'overlap.txt', reason: 'changed_since' }],
      }),
      expect.objectContaining({
        by: 'retry',
        restored: [],
        skipped: [{ path: 'overlap.txt', reason: 'changed_since' }],
      }),
    ]);
    const notice = events.find((e) => e.type === 'assistant_end');
    expect(notice).toMatchObject({
      message: {
        notice: "Couldn't undo the previous attempt's edits. overlap.txt changed since and was left as it is.",
      },
    });
  });
});
