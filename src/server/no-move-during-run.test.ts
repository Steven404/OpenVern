// A chat's project never changes while a turn runs or is starting in it: a move and a project removal are refused
// (409) then, and a turn can't start while a move or a removal covering its chat is committing. So a turn's writes stay
// in one project and one batch. Through the real routes, the real agent and the real change service.

import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHAT_PROJECT_CHANGED, MOVE_WHILE_RUNNING, REMOVE_WHILE_RUNNING, type UndoBatchResponse } from '@shared/api';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@shared/constants';
import type { AgentEvent } from '@shared/events';
import type { ChatChanges } from '@shared/types';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCore } from '../core';
import { gate, tempVolumeIgnoresCase } from '../core/changes/auto-test-helpers';
import { createFakeProvider, type FakeProvider } from '../core/providers/fake';
import { createFileSecretStore } from '../core/storage';
import type { Core } from '../core/types';
import { createApp } from './app';
import { collectEvents } from './test-helpers';

const IGNORES_CASE = tempVolumeIgnoresCase();
const NEEDS_CASE_INSENSITIVE =
  'needs a case-insensitive temp volume: on a case-sensitive one overlap.txt and OVERLAP.txt are two files, so the rename can’t make one file of them';
const NEEDS_CASE_SENSITIVE =
  'needs a case-sensitive temp volume: on a case-insensitive one overlap.txt and OVERLAP.txt are one file';

const MODEL = 'anthropic/claude-sonnet-5.5';
const R1 = 'first write\n';
const R2 = 'second write\n';

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
  root = await mkdtemp(path.join(tmpdir(), 'openvern-no-move-'));
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
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const getChanges = async (chatId: string) => (await (await call(`/api/chats/${chatId}/changes`)).json()) as ChatChanges;

async function autoChat(projectId = projectA): Promise<string> {
  const created = await call('/api/chats', {
    method: 'POST',
    json: { projectId, model: MODEL, editMode: 'auto', expectedInGitRepo: false },
  });
  expect(created.status).toBe(200);
  return ((await created.json()) as { id: string }).id;
}

const send = (chatId: string, projectId: string | null = projectA, text = 'go') =>
  call(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    json: { text, model: MODEL, attachmentIds: [], expectedEditMode: 'auto', expectedProjectId: projectId },
  });

const move = (chatId: string, from: string | null, to: string | null) =>
  call(`/api/chats/${chatId}`, {
    method: 'PATCH',
    json: { projectId: to, expectedEditMode: 'auto', expectedProjectId: from, expectedInGitRepo: false },
  });

const removeProject = (projectId: string) => call(`/api/projects/${projectId}`, { method: 'DELETE' });

const retry = (chatId: string) =>
  call(`/api/chats/${chatId}/retry`, {
    method: 'POST',
    json: { model: MODEL, expectedEditMode: 'auto', expectedProjectId: projectA },
  });

async function expectConflict(res: Response | undefined, message: string) {
  if (!res) throw new Error('Expected a response');
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: 'conflict', message } });
}

const tool = (id: string, name: string, args: unknown) => ({
  type: 'tool_call' as const,
  call: { id, name, argsJson: JSON.stringify(args) },
});

/**
 * Scripts the model: each entry is one step's tool calls; after the last, it answers "Done." `holdBefore` is the step
 * (1-based) that waits on `hold` before its calls, so the turn is running when the test acts.
 */
function script(steps: ReturnType<typeof tool>[][], hold?: { gate: ReturnType<typeof gate>; holdBefore: number }) {
  let calls = 0;
  return vi.spyOn(provider, 'stream').mockImplementation(async function* () {
    calls += 1;
    if (hold && calls === hold.holdBefore) await hold.gate.hold();
    const step = steps[calls - 1];
    if (!step) {
      yield { type: 'text_delta', delta: 'Done.' };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    for (const c of step) yield c;
    yield { type: 'finish', reason: 'tool_calls' };
  });
}

/**
 * Holds the next turn while it is starting: the route's read of the chat under its start claim, before the run is
 * registered. `entered` resolves once it is held there; `open` lets it go on.
 */
function holdTurnStart(chatId: string) {
  const hold = gate();
  const original = core.chats.get.bind(core.chats);
  let armed = true;
  vi.spyOn(core.chats, 'get').mockImplementation(async (id) => {
    if (armed && id === chatId) {
      armed = false;
      await hold.hold();
    }
    return original(id);
  });
  return hold;
}

/** Holds the next project change made through a route right before it commits (`changeProject`). */
function holdProjectChange() {
  const hold = gate();
  const original = core.changes.changeProject.bind(core.changes);
  let held = false;
  vi.spyOn(core.changes, 'changeProject').mockImplementation(async (id, commit) => {
    if (!held) {
      held = true;
      await hold.hold();
    }
    return original(id, commit);
  });
  return hold;
}

describe('a move is refused while a turn runs or is starting in the chat', () => {
  it('while an Auto turn runs: 409, the chat stays where it is, and the turn’s writes stay in one batch', async () => {
    const chatId = await autoChat();
    const hold = gate();
    script(
      [
        [tool('c1', 'write_file', { path: 'a.txt', content: R1 })],
        [tool('c2', 'write_file', { path: 'b.txt', content: R2 })],
      ],
      { gate: hold, holdBefore: 2 },
    );
    const sent = Promise.resolve(send(chatId)).then(collectEvents);
    await hold.entered;
    let moved: Response | undefined;
    try {
      moved = await move(chatId, projectA, projectB);
    } finally {
      hold.open();
    }
    await expectConflict(moved, MOVE_WHILE_RUNNING);
    expect(types(await sent)).not.toContain('error');
    const chat = await core.chats.get(chatId);
    expect(chat).toMatchObject({ projectId: projectA, editMode: 'auto' });
    expect(await readFile(path.join(dirA, 'b.txt'), 'utf8')).toBe(R2);
    expect(await exists(path.join(dirB, 'b.txt'))).toBe(false);
    const applied = (await getChanges(chatId)).applied;
    expect(applied.map((b) => b.written.map((f) => f.path))).toEqual([['a.txt', 'b.txt']]);
    // Once the turn has ended the move goes through.
    expect((await move(chatId, projectA, projectB)).status).toBe(200);
  });

  it('while a turn is starting (claimed, not yet running): 409, and the turn runs in the chat’s project', async () => {
    const chatId = await autoChat();
    script([[tool('c1', 'write_file', { path: 'a.txt', content: R1 })]]);
    const hold = holdTurnStart(chatId);
    const sent = Promise.resolve(send(chatId)).then(collectEvents);
    await hold.entered;
    let moved: Response | undefined;
    try {
      moved = await move(chatId, projectA, projectB);
    } finally {
      hold.open();
    }
    await expectConflict(moved, MOVE_WHILE_RUNNING);
    expect(types(await sent)).not.toContain('error');
    expect((await core.chats.get(chatId)).projectId).toBe(projectA);
    expect(await readFile(path.join(dirA, 'a.txt'), 'utf8')).toBe(R1);
  });
});

describe('removing a project is refused while a chat of it runs or is starting', () => {
  /** A second chat of A with a pending Review proposal, which a removal would discard. */
  async function chatWithProposal(): Promise<string> {
    const chatId = (await core.chats.create({ projectId: projectA, model: MODEL })).id;
    const stream = script([[tool('p1', 'write_file', { path: 'proposed.txt', content: R1 })]]);
    const res = await call(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      json: { text: 'propose', model: MODEL, attachmentIds: [] },
    });
    expect(types(await collectEvents(res))).not.toContain('error');
    stream.mockRestore();
    expect((await getChanges(chatId)).pending?.files.map((f) => f.path)).toEqual(['proposed.txt']);
    return chatId;
  }

  async function expectNothingRemoved(chatIds: string[]) {
    expect((await core.projects.list()).map((p) => p.id)).toContain(projectA);
    for (const id of chatIds) expect((await core.chats.get(id)).projectId).toBe(projectA);
  }

  it('while a turn runs: 409, the project, its chats and their proposals are untouched', async () => {
    const reviewing = await chatWithProposal();
    const chatId = await autoChat();
    const hold = gate();
    script([[tool('c1', 'write_file', { path: 'a.txt', content: R1 }), tool('c2', 'read_file', { path: 'a.txt' })]], {
      gate: hold,
      holdBefore: 1,
    });
    const sent = Promise.resolve(send(chatId)).then(collectEvents);
    await hold.entered;
    let removed: Response | undefined;
    try {
      removed = await removeProject(projectA);
    } finally {
      hold.open();
    }
    await expectConflict(removed, REMOVE_WHILE_RUNNING);
    expect(types(await sent)).not.toContain('error');
    await expectNothingRemoved([chatId, reviewing]);
    expect((await getChanges(reviewing)).pending?.files.map((f) => f.path)).toEqual(['proposed.txt']);
    expect((await getChanges(chatId)).applied).toHaveLength(1);
    // Once the turn has ended the removal goes through.
    expect((await removeProject(projectA)).status).toBe(204);
    expect((await core.chats.get(chatId)).projectId).toBeNull();
  });

  it('while a turn is starting: 409, nothing removed, and the turn runs in the project', async () => {
    const chatId = await autoChat();
    script([[tool('c1', 'write_file', { path: 'a.txt', content: R1 })]]);
    const hold = holdTurnStart(chatId);
    const sent = Promise.resolve(send(chatId)).then(collectEvents);
    await hold.entered;
    let removed: Response | undefined;
    try {
      removed = await removeProject(projectA);
    } finally {
      hold.open();
    }
    await expectConflict(removed, REMOVE_WHILE_RUNNING);
    expect(types(await sent)).not.toContain('error');
    await expectNothingRemoved([chatId]);
    expect(await readFile(path.join(dirA, 'a.txt'), 'utf8')).toBe(R1);
  });
});

describe('a turn starting while a move or a removal commits: exactly one goes ahead', () => {
  it('a move held at its commit: a send is refused and stores nothing; the move lands', async () => {
    const chatId = await autoChat();
    const stream = script([[tool('c1', 'write_file', { path: 'a.txt', content: R1 })]]);
    const moveHold = holdProjectChange();
    const moving = move(chatId, projectA, projectB);
    await moveHold.entered;
    let sent: Response | undefined;
    try {
      sent = await send(chatId);
    } finally {
      moveHold.open();
    }
    await expectConflict(sent, CHAT_PROJECT_CHANGED);
    expect((await moving).status).toBe(200);
    expect(stream).not.toHaveBeenCalled();
    expect((await core.chats.get(chatId)).messages).toEqual([]);
    // The next send shows the new project and runs there.
    expect(types(await collectEvents(await send(chatId, projectB)))).not.toContain('error');
    expect(await readFile(path.join(dirB, 'a.txt'), 'utf8')).toBe(R1);
    expect(await exists(path.join(dirA, 'a.txt'))).toBe(false);
  });

  it('a turn holding its start claim: the move is refused; the turn runs whole in A, one batch', async () => {
    const chatId = await autoChat();
    script([
      [tool('c1', 'write_file', { path: 'a.txt', content: R1 })],
      [tool('c2', 'write_file', { path: 'b.txt', content: R2 })],
    ]);
    const hold = holdTurnStart(chatId);
    const sent = Promise.resolve(send(chatId)).then(collectEvents);
    await hold.entered;
    let moved: Response | undefined;
    try {
      moved = await move(chatId, projectA, projectB);
    } finally {
      hold.open();
    }
    await expectConflict(moved, MOVE_WHILE_RUNNING);
    expect(types(await sent)).not.toContain('error');
    expect((await getChanges(chatId)).applied.map((b) => b.written.map((f) => f.path))).toEqual([['a.txt', 'b.txt']]);
  });

  it('a removal held at its first detach: a send in a chat of the project is refused; the removal lands', async () => {
    const chatId = await autoChat();
    const stream = script([[tool('c1', 'write_file', { path: 'a.txt', content: R1 })]]);
    const removeHold = holdProjectChange();
    const removing = removeProject(projectA);
    await removeHold.entered;
    let sent: Response | undefined;
    try {
      sent = await send(chatId);
    } finally {
      removeHold.open();
    }
    await expectConflict(sent, CHAT_PROJECT_CHANGED);
    expect((await removing).status).toBe(204);
    expect(stream).not.toHaveBeenCalled();
    expect(await exists(path.join(dirA, 'a.txt'))).toBe(false);
    expect((await core.chats.get(chatId)).projectId).toBeNull();
  });

  it('a chat moved into a project being removed can’t start a turn there, so the fallback detach never moves a running chat', async () => {
    const listed = await autoChat();
    const late = await autoChat(projectB);
    const stream = script([[tool('c1', 'write_file', { path: 'late.txt', content: R1 })]]);
    // The removal has listed A's chats (only `listed`) and is held at its first detach.
    const removeHold = holdProjectChange();
    const removing = removeProject(projectA);
    await removeHold.entered;
    let sent: Response | undefined;
    try {
      // `late` joins A after the list: idle, so the move is allowed, but no turn can start in it while A is removed.
      expect((await move(late, projectB, projectA)).status).toBe(200);
      sent = await send(late, projectA);
    } finally {
      removeHold.open();
    }
    await expectConflict(sent, CHAT_PROJECT_CHANGED);
    expect((await removing).status).toBe(204);
    expect(stream).not.toHaveBeenCalled();
    // `projects.remove`'s fallback detached the late chat; nothing was written anywhere.
    expect((await core.chats.get(late)).projectId).toBeNull();
    expect((await core.chats.get(listed)).projectId).toBeNull();
    expect(await exists(path.join(dirA, 'late.txt'))).toBe(false);
    expect(await exists(path.join(dirB, 'late.txt'))).toBe(false);
  });

  it('a turn holding its start claim: the removal is refused and nothing is removed', async () => {
    const chatId = await autoChat();
    script([[tool('c1', 'write_file', { path: 'a.txt', content: R1 })]]);
    const hold = holdTurnStart(chatId);
    const sent = Promise.resolve(send(chatId)).then(collectEvents);
    await hold.entered;
    let removed: Response | undefined;
    try {
      removed = await removeProject(projectA);
    } finally {
      hold.open();
    }
    await expectConflict(removed, REMOVE_WHILE_RUNNING);
    expect(types(await sent)).not.toContain('error');
    expect((await core.chats.get(chatId)).projectId).toBe(projectA);
    expect((await getChanges(chatId)).applied).toHaveLength(1);
  });
});

// Two sequences that lost a user's file when a move split a running turn into two batches in one project. Both need
// the move while the turn runs; the route refuses it now, so the turn keeps one batch and the user's file survives.
describe('a turn can no longer be split by a move, so Undo and Retry keep the user’s file', () => {
  it('case-only rename: the user renames Notes.txt to notes.txt mid-turn, the turn rewrites it; Retry keeps the user’s bytes', async () => {
    const chatId = await autoChat();
    const hold = gate();
    script(
      [
        [tool('c1', 'write_file', { path: 'Notes.txt', content: R1 })],
        // Held here: the user renames the file case-only and the move is attempted, while the turn runs.
        [tool('c2', 'read_file', { path: 'notes.txt' })],
        [tool('c3', 'write_file', { path: 'notes.txt', content: R2 })],
      ],
      { gate: hold, holdBefore: 2 },
    );
    const sent = Promise.resolve(send(chatId)).then(collectEvents);
    await hold.entered;
    let moved: Response | undefined;
    try {
      await rename(path.join(dirA, 'Notes.txt'), path.join(dirA, 'notes.txt'));
      moved = await move(chatId, projectA, projectB);
    } finally {
      hold.open();
    }
    await expectConflict(moved, MOVE_WHILE_RUNNING);
    expect(types(await sent)).not.toContain('error');
    const file = path.join(dirA, 'notes.txt');
    expect(await readFile(file, 'utf8')).toBe(R2);
    // One batch for the whole turn: no move closed it halfway.
    expect((await getChanges(chatId)).applied).toHaveLength(1);
    // The user puts the first version back by hand.
    await writeFile(file, R1);

    script([]);
    const events = await collectEvents(await retry(chatId));
    expect(types(events)).not.toContain('error');
    // The turn never left these bytes under this name, so its undo leaves the file alone.
    expect(await readFile(file, 'utf8')).toBe(R1);
    expect((await getChanges(chatId)).applied[0]?.undo).toMatchObject({ by: 'retry', restored: [] });
  });

  it('separate Undo: the turn writes a file twice; the user puts back the first version; Undo leaves it', async () => {
    const chatId = await autoChat();
    const hold = gate();
    script(
      [
        [tool('c1', 'write_file', { path: 'f.txt', content: R1 })],
        // The move is attempted here, while the turn runs.
        [tool('c2', 'write_file', { path: 'f.txt', content: R2 })],
      ],
      { gate: hold, holdBefore: 2 },
    );
    const sent = Promise.resolve(send(chatId)).then(collectEvents);
    await hold.entered;
    let moved: Response | undefined;
    try {
      moved = await move(chatId, projectA, projectB);
    } finally {
      hold.open();
    }
    await expectConflict(moved, MOVE_WHILE_RUNNING);
    expect(types(await sent)).not.toContain('error');
    const file = path.join(dirA, 'f.txt');
    expect(await readFile(file, 'utf8')).toBe(R2);
    // One card for the turn, whose entry expects the turn's last bytes (R2), not the first write's (R1).
    const applied = (await getChanges(chatId)).applied;
    expect(applied).toHaveLength(1);
    const batchId = applied[0]?.id ?? '';
    await writeFile(file, R1);

    const undone = await call(`/api/chats/${chatId}/changes/batches/${batchId}/undo`, { method: 'POST', json: {} });
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as UndoBatchResponse).batch.undo).toMatchObject({
      restored: [],
      skipped: [{ path: 'f.txt', reason: 'changed_since' }],
    });
    expect(await readFile(file, 'utf8')).toBe(R1);
  });
});

// SPELLINGS OF ONE FILE ARE UNDONE TOGETHER OR NOT AT ALL: one turn reaches one file under two spellings, so its one
// batch holds an entry for each. Handled one by one, the second spelling's entry was blocked and the first one's (a
// create, whose bytes the user had put back) deleted the user's file.
describe('one batch holding two spellings of one file: Undo and Retry leave the user’s file alone', () => {
  /**
   * An Auto turn creates overlap.txt (R1); mid-turn the user renames it to OVERLAP.txt; the turn reads and rewrites
   * OVERLAP.txt (R2). Then the user renames it back to overlap.txt and puts back the first write's bytes (R1).
   */
  async function turnOverTwoSpellings(): Promise<{ chatId: string; batchId: string; file: string }> {
    const chatId = await autoChat();
    const hold = gate();
    script(
      [
        [tool('c1', 'write_file', { path: 'overlap.txt', content: R1 })],
        // Held here: the user renames the file case-only while the turn runs.
        [tool('c2', 'read_file', { path: 'OVERLAP.txt' })],
        [tool('c3', 'write_file', { path: 'OVERLAP.txt', content: R2 })],
      ],
      { gate: hold, holdBefore: 2 },
    );
    const sent = Promise.resolve(send(chatId)).then(collectEvents);
    await hold.entered;
    try {
      await rename(path.join(dirA, 'overlap.txt'), path.join(dirA, 'OVERLAP.txt'));
    } finally {
      hold.open();
    }
    expect(types(await sent)).not.toContain('error');
    expect(await readFile(path.join(dirA, 'OVERLAP.txt'), 'utf8')).toBe(R2);
    // One batch, keyed by exact path: an entry for each spelling.
    const applied = (await getChanges(chatId)).applied;
    expect(applied.map((b) => b.written.map((f) => [f.path, f.kind]))).toEqual([
      [
        ['OVERLAP.txt', 'modify'],
        ['overlap.txt', 'create'],
      ],
    ]);
    // The user renames it back and restores the first write's bytes.
    await rename(path.join(dirA, 'OVERLAP.txt'), path.join(dirA, 'overlap.txt'));
    const file = path.join(dirA, 'overlap.txt');
    await writeFile(file, R1);
    return { chatId, batchId: applied[0]?.id ?? '', file };
  }

  const bothSkipped = [
    { path: 'OVERLAP.txt', reason: 'blocked' },
    { path: 'overlap.txt', reason: 'blocked' },
  ];

  async function expectUserFileKept(file: string) {
    expect(await readFile(file, 'utf8')).toBe(R1);
    expect((await readdir(dirA)).filter((n) => n.toLowerCase() === 'overlap.txt')).toEqual(['overlap.txt']);
  }

  it('direct Undo of the batch skips both spellings (blocked) and keeps overlap.txt with the user’s bytes', async (ctx) => {
    ctx.skip(!IGNORES_CASE, NEEDS_CASE_INSENSITIVE);
    const { chatId, batchId, file } = await turnOverTwoSpellings();
    const undone = await call(`/api/chats/${chatId}/changes/batches/${batchId}/undo`, { method: 'POST', json: {} });
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as UndoBatchResponse).batch.undo).toMatchObject({
      by: 'user',
      restored: [],
      skipped: bothSkipped,
    });
    await expectUserFileKept(file);
  });

  it('Retry of the turn skips both spellings (blocked) and keeps overlap.txt with the user’s bytes', async (ctx) => {
    ctx.skip(!IGNORES_CASE, NEEDS_CASE_INSENSITIVE);
    const { chatId, file } = await turnOverTwoSpellings();
    script([]);
    const events = await collectEvents(await retry(chatId));
    expect(types(events)).not.toContain('error');
    await expectUserFileKept(file);
    expect((await getChanges(chatId)).applied[0]?.undo).toMatchObject({
      by: 'retry',
      restored: [],
      skipped: bothSkipped,
    });
  });

  // On a case-sensitive volume the two names are two files. The fold can't tell that apart from one file under two
  // spellings, so both are conservatively skipped (blocked): each keeps the turn's bytes, and neither is deleted.
  it('two distinct files differing only by case (case-sensitive volume) are both conservatively skipped', async (ctx) => {
    ctx.skip(IGNORES_CASE, NEEDS_CASE_SENSITIVE);
    const chatId = await autoChat();
    script([
      [tool('c1', 'write_file', { path: 'overlap.txt', content: R1 })],
      [tool('c2', 'write_file', { path: 'OVERLAP.txt', content: R2 })],
    ]);
    expect(types(await collectEvents(await send(chatId)))).not.toContain('error');
    const batchId = (await getChanges(chatId)).applied[0]?.id ?? '';
    const undone = await call(`/api/chats/${chatId}/changes/batches/${batchId}/undo`, { method: 'POST', json: {} });
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as UndoBatchResponse).batch.undo).toMatchObject({
      restored: [],
      skipped: bothSkipped,
    });
    expect(await readFile(path.join(dirA, 'overlap.txt'), 'utf8')).toBe(R1);
    expect(await readFile(path.join(dirA, 'OVERLAP.txt'), 'utf8')).toBe(R2);
  });
});
