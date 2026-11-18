// Review Apply through the real routes and the real change service: proposals are written only into the project they
// were made for, and only when that is the chat's current project and the one the client showed.

import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
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
