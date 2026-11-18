// Review Apply through the real routes and the real change service: proposals are written only into the project they
// were made for, and only when that is the chat's current project and the one the client showed.

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APPLY_PROJECT_CHANGED, PROPOSALS_OTHER_PROJECT } from '@shared/api';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@shared/constants';
import type { ChatChanges, HunkDecision } from '@shared/types';
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

let root: string;
let core: Core;
let app: Hono;
let provider: FakeProvider;
let dirA: string;
let dirB: string;
let projectA: string;
let projectB: string;
let chatId: string;

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
  root = await mkdtemp(path.join(tmpdir(), 'openvern-apply-project-'));
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
  chatId = (await core.chats.create({ projectId: projectA, model: MODEL })).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/**
 * A Review turn that proposes `new.txt`. With `hold`, the model's reply waits before its tool call, so the turn is
 * running in its pinned project but has staged nothing yet.
 */
function scriptStage(hold?: ReturnType<typeof gate>) {
  let calls = 0;
  vi.spyOn(provider, 'stream').mockImplementation(async function* () {
    calls += 1;
    if (calls > 1) {
      yield { type: 'text_delta', delta: 'Proposed.' };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    yield { type: 'text_delta', delta: 'Proposing a file.' };
    if (hold) await hold.hold();
    yield {
      type: 'tool_call',
      call: { id: 'call_write', name: 'write_file', argsJson: JSON.stringify({ path: 'new.txt', content: 'hi\n' }) },
    };
    yield { type: 'finish', reason: 'tool_calls' };
  });
}

const send = () =>
  call(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    json: { text: 'add a file', model: MODEL, attachmentIds: [] },
  });

async function applyBody(extra: { expectedProjectId?: string | null } = {}) {
  const changes = (await (await call(`/api/chats/${chatId}/changes`)).json()) as ChatChanges;
  const pending = changes.pending;
  if (!pending) throw new Error('Expected pending proposals');
  const decisions: Record<string, Record<string, HunkDecision>> = {};
  for (const f of pending.files) decisions[f.path] = Object.fromEntries(f.hunks.map((h) => [h.id, 'accepted']));
  return { revision: pending.revision, decisions, ...extra };
}
const apply = (body: unknown) => call(`/api/chats/${chatId}/changes/apply`, { method: 'POST', json: body });

async function expectConflict(res: Response, message: string) {
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: 'conflict', message } });
}

describe('Review Apply and the project the proposals were made for', () => {
  it('a turn pinned to A stages after the chat moved to B: Apply is a 409 and neither folder is written', async () => {
    const hold = gate();
    scriptStage(hold);
    const consumed = collectEvents(await send());
    await hold.entered;
    try {
      // The pending set is empty, so the move is allowed while the turn runs.
      const moved = await call(`/api/chats/${chatId}`, { method: 'PATCH', json: { projectId: projectB } });
      expect(moved.status).toBe(200);
    } finally {
      hold.open();
      await consumed;
    }
    expect((await core.chats.get(chatId)).projectId).toBe(projectB);
    const body = await applyBody();
    expect(body.decisions).toHaveProperty('new.txt');

    // The client shows B (the chat's current project); a client that sends nothing is refused too.
    await expectConflict(await apply({ ...body, expectedProjectId: projectB }), PROPOSALS_OTHER_PROJECT);
    await expectConflict(await apply(body), PROPOSALS_OTHER_PROJECT);
    expect(await readdir(dirB)).toEqual([]);
    expect(await readdir(dirA)).toEqual([]);
    // Still pending, and Discard always works.
    const discarded = await call(`/api/chats/${chatId}/changes`, { method: 'DELETE' });
    expect(discarded.status).toBe(200);
    expect(((await discarded.json()) as ChatChanges).pending).toBeNull();
    expect(await readdir(dirB)).toEqual([]);
  });

  it('a stale expectedProjectId is a 409 that writes nothing; the shown current project applies', async () => {
    scriptStage();
    await collectEvents(await send());
    const body = await applyBody();
    await expectConflict(await apply({ ...body, expectedProjectId: projectB }), APPLY_PROJECT_CHANGED);
    await expectConflict(await apply({ ...body, expectedProjectId: null }), APPLY_PROJECT_CHANGED);
    expect(await readdir(dirA)).toEqual([]);
    const res = await apply({ ...body, expectedProjectId: projectA });
    expect(res.status).toBe(200);
    expect(await readFile(path.join(dirA, 'new.txt'), 'utf8')).toBe('hi\n');
    expect(await readdir(dirB)).toEqual([]);
  });
});

describe('a retry never brings back proposals that could be written into another project', () => {
  it('a legacy unbound set snapshotted by a turn, discarded, then restored by a retry after a move: Apply is a 409', async () => {
    // Turn 1 proposes new.txt in A; the store is then rewritten as an older build left it (no binding).
    scriptStage();
    await collectEvents(await send());
    const storeFile = path.join(await realpath(path.join(root, 'data')), 'changes', `${chatId}.json`);
    const { pendingProjectId, ...legacy } = JSON.parse(await readFile(storeFile, 'utf8'));
    expect(pendingProjectId).toBe(projectA);
    await writeFile(storeFile, JSON.stringify(legacy));
    // Turn 2 starts on this build and snapshots the unbound set.
    await collectEvents(await send());
    // Discard, move to B, then retry turn 2: the snapshot comes back.
    expect((await call(`/api/chats/${chatId}/changes`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/api/chats/${chatId}`, { method: 'PATCH', json: { projectId: projectB } })).status).toBe(200);
    const retried = await call(`/api/chats/${chatId}/retry`, {
      method: 'POST',
      json: { model: MODEL, expectedProjectId: projectB },
    });
    expect(retried.status).toBe(200);
    await collectEvents(retried);
    const body = await applyBody();
    expect(body.decisions).toHaveProperty('new.txt');

    await expectConflict(await apply({ ...body, expectedProjectId: projectB }), PROPOSALS_OTHER_PROJECT);
    expect(await readdir(dirB)).toEqual([]);
    expect(await readdir(dirA)).toEqual([]);
    const discarded = await call(`/api/chats/${chatId}/changes`, { method: 'DELETE' });
    expect(((await discarded.json()) as ChatChanges).pending).toBeNull();
  });
});

/**
 * Holds the next change of the chat's project made through a route right before it commits: the point where its
 * pending check and its write run under the chat's change-store lock (`changeProject`). `entered` resolves once it is
 * held there; `open` lets it go on.
 */
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

/** Runs `between` after the Apply route has read the chat's project, before the change service is called. */
function afterApplyRead(between: () => Promise<void>) {
  const original = core.changes.apply.bind(core.changes);
  vi.spyOn(core.changes, 'apply').mockImplementation(async (input) => {
    await between();
    return original(input);
  });
}

describe('a move or a detach can never land between Apply’s project check and its writes', () => {
  it('a move that started before the stage commits after Apply read the project: refused, Apply writes into A', async () => {
    const turnHold = gate();
    scriptStage(turnHold);
    const consumed = collectEvents(await send());
    await turnHold.entered;
    // The move starts while nothing is pending, and is held right before it commits.
    const moveHold = holdProjectChange();
    const moving = call(`/api/chats/${chatId}`, { method: 'PATCH', json: { projectId: projectB } });
    await moveHold.entered;
    turnHold.open();
    await consumed;
    const body = await applyBody();
    let moved: Response | undefined;
    afterApplyRead(async () => {
      moveHold.open();
      moved = await moving;
    });

    const res = await apply({ ...body, expectedProjectId: projectA });
    // The move checks for pending proposals when it commits, so it is refused; the chat stays in A, where Apply wrote.
    expect(moved?.status).toBe(409);
    expect(res.status).toBe(200);
    expect((await core.chats.get(chatId)).projectId).toBe(projectA);
    expect(await readFile(path.join(dirA, 'new.txt'), 'utf8')).toBe('hi\n');
    expect(await readdir(dirB)).toEqual([]);
  });

  it('a project removal that started before the stage detaches after Apply read the project: Apply is a 409', async () => {
    const turnHold = gate();
    scriptStage(turnHold);
    const consumed = collectEvents(await send());
    await turnHold.entered;
    const removeHold = holdProjectChange();
    const removing = call(`/api/projects/${projectA}`, { method: 'DELETE' });
    await removeHold.entered;
    turnHold.open();
    await consumed;
    const body = await applyBody();
    let removed: Response | undefined;
    afterApplyRead(async () => {
      removeHold.open();
      removed = await removing;
    });

    const res = await apply({ ...body, expectedProjectId: projectA });
    expect(removed?.status).toBe(204);
    // The detach discarded the proposals and moved the chat to "Chats"; Apply, checking under the store lock, wrote
    // nothing.
    await expectConflict(res, APPLY_PROJECT_CHANGED);
    expect((await core.chats.get(chatId)).projectId).toBeNull();
    expect(await readdir(dirA)).toEqual([]);
    expect(await readdir(dirB)).toEqual([]);
    expect((await core.changes.get(chatId)).pending).toBeNull();
  });

  it('a project change with no route around it (a detach by projects.remove) after Apply read the project: 409', async () => {
    scriptStage();
    await collectEvents(await send());
    const body = await applyBody();
    afterApplyRead(() => core.projects.remove(projectA));

    await expectConflict(await apply({ ...body, expectedProjectId: projectA }), APPLY_PROJECT_CHANGED);
    expect((await core.chats.get(chatId)).projectId).toBeNull();
    expect(await readdir(dirA)).toEqual([]);
    // Still pending (nothing discarded it), and Discard works.
    expect((await core.changes.get(chatId)).pending?.files.map((f) => f.path)).toEqual(['new.txt']);
    expect((await call(`/api/chats/${chatId}/changes`, { method: 'DELETE' })).status).toBe(200);
  });

  it('a chat deleted while its project is being removed does not abort the removal', async () => {
    const other = (await core.chats.create({ projectId: projectA, model: MODEL })).id;
    const update = core.chats.update.bind(core.chats);
    let deleted = false;
    vi.spyOn(core.chats, 'update').mockImplementation(async (id, patch, expect) => {
      // The first detach races a delete of that chat: the chat is gone by the time the update runs.
      if (!deleted && patch.projectId === null) {
        deleted = true;
        await core.chats.remove(id);
      }
      return update(id, patch, expect);
    });

    const res = await call(`/api/projects/${projectA}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(deleted).toBe(true);
    expect((await core.projects.list()).map((p) => p.id)).not.toContain(projectA);
    const left = (await core.chats.list()).filter((c) => c.id === chatId || c.id === other);
    expect(left).toHaveLength(1);
    expect(left[0]?.projectId).toBeNull();
  });

  it('a stage racing a move: the move commits only if nothing was pending when it committed', async () => {
    const turnHold = gate();
    scriptStage(turnHold);
    const consumed = collectEvents(await send());
    await turnHold.entered;
    const moveHold = holdProjectChange();
    const moving = call(`/api/chats/${chatId}`, { method: 'PATCH', json: { projectId: projectB } });
    await moveHold.entered;
    // The turn, pinned to A, stages while the move is on its way.
    turnHold.open();
    await consumed;
    expect((await core.changes.get(chatId)).pending?.files.map((f) => f.path)).toEqual(['new.txt']);
    moveHold.open();
    const moved = await moving;

    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({
      error: { code: 'conflict', message: 'Apply or discard the proposed edits first.' },
    });
    // The proposals stay with the project they were made for, which is still the chat's.
    expect((await core.chats.get(chatId)).projectId).toBe(projectA);
    const res = await apply({ ...(await applyBody()), expectedProjectId: projectA });
    expect(res.status).toBe(200);
    expect(await readFile(path.join(dirA, 'new.txt'), 'utf8')).toBe('hi\n');
    expect(await readdir(dirB)).toEqual([]);
  });
});
