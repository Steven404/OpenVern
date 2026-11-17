import type { AppliedBatch, Chat, EditMode } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gate } from '../core/changes/auto-test-helpers';
import { CoreError } from '../core/errors';
import { collectEvents, createHarness, type Harness, PNG_BYTES } from './test-helpers';

const MODEL = 'anthropic/claude-sonnet-5.5';
const WAIT = 'Wait for the response to finish before undoing edits.';
const NO_PROJECT = 'This chat has no project to write to.';
const UNAVAILABLE = 'These edits can no longer be undone.';
let h: Harness;
let projectId: string;
let chat: Chat;
beforeEach(async () => {
  h = await createHarness();
  const project = await h.core.projects.create({ rootPath: h.projectDir });
  projectId = project.id;
  chat = await h.core.chats.create({ projectId, model: MODEL });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});
const patch = (body: unknown) => h.call(`/api/chats/${chat.id}`, { method: 'PATCH', json: body });
const undo = (id = 'batch', chatId = chat.id, json?: unknown) =>
  h.call(`/api/chats/${chatId}/changes/batches/${id}/undo`, {
    method: 'POST',
    ...(json === undefined ? {} : { json }),
  });
const batch = (extra: Partial<AppliedBatch> = {}): AppliedBatch => ({
  id: 'batch',
  appliedAt: new Date(0).toISOString(),
  messageId: 'assistant',
  turnId: 'user',
  source: 'auto',
  undoable: true,
  written: [{ path: 'a.txt', kind: 'create', add: 1, del: 0, hunks: [] }],
  rejectedHunks: 0,
  skippedHunks: 0,
  conflicts: [],
  ...extra,
});
async function error(res: Response, status: number, code: string, message?: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ error: { code, ...(message ? { message } : {}) } });
}

describe('Auto mode public routes', () => {
  it.each(['auto', 'review'] as const)(
    'PATCH persists valid editMode %s without bumping updatedAt',
    async (editMode) => {
      expect((await patch({ editMode })).status).toBe(200);
      expect(await h.core.chats.get(chat.id)).toMatchObject({ editMode, updatedAt: chat.updatedAt });
    },
  );
  it('PATCH rejects bogus editMode without mutation', async () => {
    await error(await patch({ editMode: 'bogus' }), 400, 'invalid_request');
    expect(await h.core.chats.get(chat.id)).toEqual(chat);
  });
  it.each([undefined, 'auto', 'review'] as const)(
    'createChat with editMode %s persists its default or explicit mode',
    async (editMode: EditMode | undefined) => {
      const res = await h.call('/api/chats', {
        method: 'POST',
        json: { projectId, model: MODEL, ...(editMode ? { editMode } : {}) },
      });
      expect(res.status).toBe(200);
      const created = (await res.json()) as Chat;
      expect(created.editMode).toBe(editMode ?? 'review');
      expect((await h.core.chats.get(created.id)).editMode).toBe(editMode ?? 'review');
    },
  );
  it('PATCH mode is allowed during a real active run but a combined archive PATCH is refused atomically', async () => {
    const hold = gate();
    vi.spyOn(h.provider, 'stream').mockImplementation(async function* () {
      yield { type: 'text_delta', delta: 'working' };
      await hold.hold();
      yield { type: 'finish', reason: 'stop' };
    });
    const response = await h.call(`/api/chats/${chat.id}/messages`, {
      method: 'POST',
      json: { text: 'hello', model: MODEL, attachmentIds: [] },
    });
    const consumed = collectEvents(response);
    await hold.entered;
    expect(h.core.agent.isRunning(chat.id)).toBe(true);
    try {
      expect((await patch({ editMode: 'auto' })).status).toBe(200);
      await error(
        await patch({ editMode: 'review', archived: true }),
        409,
        'conflict',
        'Wait for the response to finish before archiving or unarchiving this chat.',
      );
      expect(await h.core.chats.get(chat.id)).toMatchObject({ editMode: 'auto', archived: false });
      await error(await undo(), 409, 'conflict', WAIT);
      expect(h.changes.undoCalls).toEqual([]);
    } finally {
      hold.open();
      await consumed;
    }
  });
  it('undo refuses while a real turn is starting before model validation finishes', async () => {
    const hold = gate();
    const attachment = await h.core.attachments.create({ name: 'image.png', bytes: PNG_BYTES });
    const original = h.core.attachments.get.bind(h.core.attachments);
    vi.spyOn(h.core.attachments, 'get').mockImplementation(async (id) => {
      await hold.hold();
      return original(id);
    });
    const sending = h.call(`/api/chats/${chat.id}/messages`, {
      method: 'POST',
      json: { text: 'hello', model: MODEL, attachmentIds: [attachment.id] },
    });
    await hold.entered;
    try {
      expect(h.core.agent.isRunning(chat.id)).toBe(false);
      await error(await undo(), 409, 'conflict', WAIT);
      expect(h.changes.undoCalls).toEqual([]);
    } finally {
      hold.open();
      await collectEvents(await sending);
    }
  });
  it('undo returns 404 for unknown batch and unknown chat', async () => {
    await error(await undo('unknown'), 404, 'not_found', 'These edits were not found.');
    await error(await undo('batch', 'unknown'), 404, 'not_found');
    expect(h.changes.undoCalls).toHaveLength(1);
  });
  it.each([
    ['review batch', { source: 'review', undoable: false }],
    ['undone batch', { undo: { at: '', by: 'user', restored: ['a.txt'], skipped: [] } }],
    ['batch past retention', { undoable: false }],
  ] satisfies [string, Partial<AppliedBatch>][])('undo conflicts for a %s', async (_, extra) => {
    h.changes.seedBatch(chat.id, batch(extra), { projectId });
    await error(await undo(), 409, 'conflict', UNAVAILABLE);
    expect((await h.changes.get(chat.id)).diskSeq).toBe(0);
  });
  it('undo conflicts for a batch from another project', async () => {
    h.changes.seedBatch(chat.id, batch(), { projectId: 'other' });
    await error(await undo(), 409, 'conflict', UNAVAILABLE);
  });
  it('undo conflicts for a loose chat', async () => {
    await h.core.chats.update(chat.id, { projectId: null });
    await error(await undo(), 409, 'conflict', NO_PROJECT);
    expect(h.changes.undoCalls).toEqual([]);
  });
  it('undo conflicts when the stored project no longer exists', async () => {
    vi.spyOn(h.core.projects, 'get').mockRejectedValue(new CoreError('not_found'));
    await error(await undo(), 409, 'conflict', NO_PROJECT);
    expect(h.changes.undoCalls).toEqual([]);
  });
  it.each([undefined, {}])('undo succeeds with body %j and returns batch and changes', async (body) => {
    h.changes.seedBatch(chat.id, batch(), { projectId });
    const res = await undo('batch', chat.id, body);
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result).toEqual({
      batch: {
        ...batch(),
        undoable: false,
        undo: { at: expect.any(String), by: 'user', restored: ['a.txt'], skipped: [] },
      },
      changes: {
        pending: null,
        applied: [
          {
            ...batch(),
            undoable: false,
            undo: { at: expect.any(String), by: 'user', restored: ['a.txt'], skipped: [] },
          },
        ],
        diskSeq: 1,
      },
    });
    expect(h.changes.undoCalls).toEqual([
      { chatId: chat.id, projectId, projectRoot: expect.any(String), batchId: 'batch' },
    ]);
    await error(await undo(), 409, 'conflict', UNAVAILABLE);
  });
  it('undo requires the client header and rejects malformed JSON', async () => {
    expect((await h.app.request(`/api/chats/${chat.id}/changes/batches/batch/undo`, { method: 'POST' })).status).toBe(
      403,
    );
    await error(
      await h.call(`/api/chats/${chat.id}/changes/batches/batch/undo`, {
        method: 'POST',
        body: '{',
        headers: { 'Content-Type': 'application/json' },
      }),
      400,
      'invalid_request',
    );
    expect(h.changes.undoCalls).toEqual([]);
  });
});
