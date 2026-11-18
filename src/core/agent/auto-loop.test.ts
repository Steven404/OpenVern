import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '@shared/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AutoSetup, setupAuto } from '../changes/auto-test-helpers';
import type { FakeScript, FakeStep } from '../providers/fake';
import { getProjectTools } from '../tools';
import type { ToolChanges } from '../tools/types';
import { autoUnreadText, editPromptLines, editToolDescriptions, retryUndoNote, retryUndoNotice } from './edit-mode';
import { createHarness, type Harness, PROJECT } from './test-helpers';

const reply: FakeStep[] = [
  { type: 'text_delta', delta: 'Done' },
  { type: 'finish', reason: 'stop' },
];
const calls = (...items: [string, object][]): FakeStep[] => [
  ...items.map(
    ([name, args], i): FakeStep => ({
      type: 'tool_call',
      call: { id: `call-${i}`, name, argsJson: JSON.stringify(args) },
    }),
  ),
  { type: 'finish', reason: 'tool_calls' },
];
let s: AutoSetup;
let h: Harness;
beforeEach(async () => {
  s = await setupAuto();
  await s.seed('a.txt', 'original\n');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(path.dirname(s.root), { recursive: true, force: true });
});
async function setup(script: FakeScript, auto = true) {
  h = await createHarness({ script, changes: s.svc, projectRoot: s.root, getProjectTools });
  // Avoid unrelated title requests when counting model calls.
  await h.chats.update(h.chatId, { title: 'Test', editMode: auto ? 'auto' : 'review' });
  return h;
}
const results = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'tool_result' ? [e.message] : []));

describe('Auto agent loop with real files', () => {
  it('freezes Review for both steps despite a step-one PATCH, then uses Auto on the next turn', async () => {
    await setup((_, index) => {
      if (index === 0) {
        // The chats service updates synchronously before its promise resolves.
        void h.chats.update(h.chatId, { editMode: 'auto' });
        return calls(['write_file', { path: 'review.txt', content: 'proposal' }]);
      }
      return index === 2 ? calls(['write_file', { path: 'auto.txt', content: 'written' }]) : reply;
    }, false);
    // Reuse the mode-aware factory supplied by the harness; tool contexts prove the write path too.
    const contexts = vi.spyOn(s.svc, 'tools');
    const first = await h.run();
    for (const req of h.provider.calls.slice(0, 2)) {
      for (const line of editPromptLines('review')) expect(req.system).toContain(line);
      expect(req.tools?.find((t) => t.name === 'write_file')?.description).toBe(editToolDescriptions('review').write);
    }
    expect(contexts.mock.calls.map(([input]) => input.mode)).toEqual(['review', 'review']);
    expect(first.some((e) => e.type === 'auto_batch_updated')).toBe(false);
    expect(await s.exists('review.txt')).toBe(false);
    await h.run({ newUserMessage: { text: 'next', attachmentIds: [] } });
    const next = h.provider.calls[2];
    for (const line of editPromptLines('auto')) expect(next?.system).toContain(line);
    expect(next?.tools?.find((t) => t.name === 'write_file')?.description).toBe(editToolDescriptions('auto').write);
    expect(await s.read('auto.txt')).toBe('written');
  });

  it('emits auto_batch_updated only immediately after a tool result that wrote', async () => {
    await setup((_, i) =>
      i === 0
        ? calls(
            ['read_file', { path: 'a.txt' }],
            ['write_file', { path: 'a.txt', content: 'original\n' }],
            ['write_file', { path: 'new.txt', content: 'new' }],
            ['write_file', { path: 'missing-parent.txt', content: '«redacted:secret»' }],
            ['list_files', {}],
          )
        : reply,
    );
    const events = await h.run();
    const updates = events.flatMap((e, i) => (e.type === 'auto_batch_updated' ? [{ e, previous: events[i - 1] }] : []));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.previous).toMatchObject({
      type: 'tool_result',
      message: { name: 'write_file', ok: true, output: 'Created new.txt (1 line). Written to disk.' },
    });
    expect(events.some((e) => e.type === 'changes_updated')).toBe(false);
    expect(results(events).map((r) => r.ok)).toEqual([true, true, true, false, true]);
    expect(updates[0]?.e).toMatchObject({ batchId: (await s.svc.get(h.chatId)).applied[0]?.id });
  });

  it('passes the captured mode and firstTurn to takeNote', async () => {
    const note = vi.spyOn(s.svc, 'takeNote');
    await setup(() => reply);
    await h.run();
    await h.chats.update(h.chatId, { editMode: 'review' });
    await h.run();
    expect(note.mock.calls).toEqual([
      [h.chatId, { mode: 'auto', firstTurn: true }],
      [h.chatId, { mode: 'review', firstTurn: false }],
    ]);
  });

  it.each(['auto', 'review'] as const)(
    'retry in %s restores Auto files before the model and notices only the first assistant',
    async (mode) => {
      let retrying = false;
      let observed = false;
      await setup((_, i) => {
        if (retrying && !observed) {
          expect(readFileSync(s.abs('a.txt'), 'utf8')).toBe('original\n');
          observed = true;
        }
        return i === 0
          ? calls(['edit_file', { path: 'a.txt', old_string: 'original', new_string: 'changed' }])
          : i === 2
            ? calls(['read_file', { path: 'a.txt' }])
            : reply;
      });
      await h.run();
      expect(await s.read('a.txt')).toBe('changed\n');
      await h.chats.update(h.chatId, { editMode: mode });
      retrying = true;
      const events = await h.run({ newUserMessage: undefined });
      expect(observed).toBe(true);
      const batch = (await s.svc.get(h.chatId)).applied[0];
      expect(batch?.undo).toMatchObject({ by: 'retry', restored: ['a.txt'], skipped: [] });
      const assistants = h.messages().filter((m) => m.role === 'assistant');
      expect(assistants).toHaveLength(2);
      expect(assistants[0]).toMatchObject({ notice: retryUndoNotice({ restored: ['a.txt'], skipped: [] }) });
      expect(assistants[1]).not.toHaveProperty('notice');
      expect(events.filter((e) => e.type === 'auto_batch_updated')).toHaveLength(1);
      expect(JSON.stringify(h.provider.calls.at(-1)?.messages)).not.toContain('Undid the previous');
    },
  );

  it('persists and replays the skipped-file retry note, preserves existing notes and clears all read records', async () => {
    await s.seed('seen.txt', 'read-only\n');
    await s.seed('b.txt', 'before\n');
    await setup((_, i) =>
      i === 0
        ? calls(
            ['read_file', { path: 'seen.txt' }],
            ['edit_file', { path: 'b.txt', old_string: 'before', new_string: 'after' }],
            ['edit_file', { path: 'a.txt', old_string: 'original', new_string: 'changed' }],
          )
        : i === 2
          ? calls(['write_file', { path: 'seen.txt', content: 'overwrite' }])
          : reply,
    );
    await h.run();
    const user = h.messages().find((m) => m.role === 'user');
    if (!user) throw new Error('missing user');
    await h.chats.setChangesNote(h.chatId, user.id, 'Existing note');
    await s.seed('a.txt', 'user edit\n');
    const events = await h.run({ newUserMessage: undefined });
    const undo = { restored: ['b.txt'], skipped: [{ path: 'a.txt', reason: 'changed_since' as const }] };
    const expected = `Existing note\n\n${retryUndoNote(undo)}`;
    expect(h.messages().find((m) => m.role === 'user')).toMatchObject({ changesNote: expected });
    expect(JSON.stringify(h.provider.calls[2]?.messages)).toContain(JSON.stringify(expected).slice(1, -1));
    expect(h.messages().find((m) => m.role === 'assistant')).toMatchObject({ notice: retryUndoNotice(undo) });
    expect(results(events)[0]).toMatchObject({
      ok: false,
      output: expect.stringContaining('read seen.txt with read_file first'),
    });
    expect(await s.read('seen.txt')).toBe('read-only\n');
    expect(await s.read('a.txt')).toBe('user edit\n');
    expect(await s.read('b.txt')).toBe('before\n');
  });

  it('retry of a Review turn calls prepareRetry but undoes nothing', async () => {
    const prepare = vi.spyOn(s.svc, 'prepareRetry');
    await setup((_, i) => (i === 0 ? calls(['write_file', { path: 'new.txt', content: 'proposal' }]) : reply), false);
    await h.run();
    const events = await h.run({ newUserMessage: undefined });
    expect(prepare).toHaveBeenCalledOnce();
    expect(await prepare.mock.results[0]?.value).toBeNull();
    expect(events.some((e) => e.type === 'auto_batch_updated')).toBe(false);
    expect(await s.read('a.txt')).toBe('original\n');
    expect(await s.exists('new.txt')).toBe(false);
    expect((await s.svc.get(h.chatId)).applied).toEqual([]);
  });

  it('Stop after a real write retains its actual persisted tool result', async () => {
    const controller = new AbortController();
    const tools = getProjectTools({ editMode: 'auto' }).map((tool) =>
      tool.spec.name !== 'write_file'
        ? tool
        : {
            ...tool,
            run: async (...args: Parameters<typeof tool.run>) => {
              const result = await tool.run(...args);
              controller.abort();
              return result;
            },
          },
    );
    h = await createHarness({
      script: (_, i) => (i === 0 ? calls(['write_file', { path: 'new.txt', content: 'real write' }]) : reply),
      tools,
      changes: s.svc,
      projectRoot: s.root,
    });
    await h.chats.update(h.chatId, { title: 'Test', editMode: 'auto' });
    const events = await h.run({ signal: controller.signal });
    expect(await s.read('new.txt')).toBe('real write');
    const result = { ok: true, output: 'Created new.txt (1 line). Written to disk.' };
    expect(results(events)[0]).toMatchObject(result);
    expect(h.messages().find((m) => m.role === 'tool')).toMatchObject(result);
    expect(events.some((e) => e.type === 'auto_batch_updated')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(h.provider.calls.filter((req) => req.maxTokens === undefined)).toHaveLength(1);
  });
  it('Stop after a no-op write interrupts the result and emits no batch update', async () => {
    const controller = new AbortController();
    const tools = getProjectTools({ editMode: 'auto' }).map((tool) =>
      tool.spec.name !== 'write_file'
        ? tool
        : {
            ...tool,
            run: async (...args: Parameters<typeof tool.run>) => {
              const result = await tool.run(...args);
              expect(result.ok).toBe(true);
              controller.abort();
              return result;
            },
          },
    );
    h = await createHarness({
      script: (_, i) =>
        i === 0
          ? calls(['read_file', { path: 'a.txt' }], ['write_file', { path: 'a.txt', content: 'original\n' }])
          : reply,
      tools,
      changes: s.svc,
      projectRoot: s.root,
    });
    await h.chats.update(h.chatId, { title: 'Test', editMode: 'auto' });
    const events = await h.run({ signal: controller.signal });
    expect(results(events)[1]).toMatchObject({ ok: false, summary: 'Interrupted' });
    expect(h.messages().filter((m) => m.role === 'tool')[1]).toMatchObject({ ok: false, summary: 'Interrupted' });
    expect(events.some((e) => e.type === 'auto_batch_updated')).toBe(false);
    expect(await s.read('a.txt')).toBe('original\n');
    expect((await s.svc.get(h.chatId)).applied).toEqual([]);
  });

  it('freezes Auto for the whole turn despite a step-one PATCH to Review, then uses Review on the next turn', async () => {
    await setup((_, index) => {
      if (index === 0) {
        void h.chats.update(h.chatId, { editMode: 'review' });
        return calls(['write_file', { path: 'auto.txt', content: 'written' }]);
      }
      if (index === 1) return calls(['write_file', { path: 'auto2.txt', content: 'also written' }]);
      return index === 3 ? calls(['write_file', { path: 'review.txt', content: 'proposal' }]) : reply;
    });
    const contexts = vi.spyOn(s.svc, 'tools');
    const first = await h.run();
    for (const req of h.provider.calls.slice(0, 3)) {
      for (const line of editPromptLines('auto')) expect(req.system).toContain(line);
      expect(req.tools?.find((t) => t.name === 'write_file')?.description).toBe(editToolDescriptions('auto').write);
    }
    expect(contexts.mock.calls.map(([input]) => input.mode)).toEqual(['auto', 'auto', 'auto']);
    expect(first.filter((e) => e.type === 'auto_batch_updated')).toHaveLength(2);
    expect(await s.read('auto.txt')).toBe('written');
    expect(await s.read('auto2.txt')).toBe('also written');
    expect((await h.chats.get(h.chatId)).editMode).toBe('review');

    await h.run({ newUserMessage: { text: 'next', attachmentIds: [] } });
    const next = h.provider.calls[3];
    for (const line of editPromptLines('review')) expect(next?.system).toContain(line);
    expect(next?.tools?.find((t) => t.name === 'write_file')?.description).toBe(editToolDescriptions('review').write);
    expect(contexts.mock.calls.slice(3).map(([input]) => input.mode)).toEqual(['review', 'review']);
    expect(await s.exists('review.txt')).toBe(false);
    expect((await s.svc.get(h.chatId)).pending?.files.map((f) => f.path)).toEqual(['review.txt']);
  });

  it.each([
    ['review', 'auto'],
    ['auto', 'review'],
  ] as const)(
    'runs the whole turn in the mode the caller checked (%s), not the stored one (%s)',
    async (given, stored) => {
      const note = vi.spyOn(s.svc, 'takeNote');
      await setup((_, index) => (index === 0 ? calls(['write_file', { path: 'n.txt', content: 'new' }]) : reply));
      await h.chats.update(h.chatId, { editMode: stored });
      const contexts = vi.spyOn(s.svc, 'tools');
      const events = await h.run({ editMode: given });
      for (const req of h.provider.calls) {
        for (const line of editPromptLines(given)) expect(req.system).toContain(line);
        expect(req.tools?.find((t) => t.name === 'write_file')?.description).toBe(editToolDescriptions(given).write);
      }
      expect(note.mock.calls).toEqual([[h.chatId, { mode: given, firstTurn: true }]]);
      expect(contexts.mock.calls.map(([input]) => input.mode)).toEqual([given, given]);
      expect(await s.exists('n.txt')).toBe(given === 'auto');
      expect(events.some((e) => e.type === 'auto_batch_updated')).toBe(given === 'auto');
      // The stored mode is left alone: it applies to a turn that is given none.
      expect((await h.chats.get(h.chatId)).editMode).toBe(stored);
    },
  );

  it('a retry undoes with the mode the caller checked', async () => {
    const retry = vi.spyOn(s.svc, 'prepareRetry');
    await setup(() => reply);
    await h.run();
    await h.chats.update(h.chatId, { editMode: 'review' });
    await h.run({ newUserMessage: undefined, editMode: 'auto' });
    expect(retry.mock.calls.map(([input]) => input.mode)).toEqual(['auto']);
  });

  it('Stop while a write is in flight keeps the real result of the write', async () => {
    const controller = new AbortController();
    const original = s.svc.tools.bind(s.svc);
    vi.spyOn(s.svc, 'tools').mockImplementation((input) => {
      const inner = original(input);
      const wrapped: ToolChanges = {
        ...inner,
        // Stop lands after the tool has checked the signal and while the change service is writing.
        write: async (...args) => {
          const pending = inner.write(...args);
          controller.abort();
          return pending;
        },
      };
      return wrapped;
    });
    await setup((_, i) => (i === 0 ? calls(['write_file', { path: 'new.txt', content: 'in flight' }]) : reply));
    const events = await h.run({ signal: controller.signal });
    expect(controller.signal.aborted).toBe(true);
    expect(await s.read('new.txt')).toBe('in flight');
    const result = { ok: true, output: 'Created new.txt (1 line). Written to disk.' };
    expect(results(events)).toMatchObject([result]);
    expect(h.messages().filter((m) => m.role === 'tool')).toMatchObject([result]);
    expect(events.filter((e) => e.type === 'auto_batch_updated')).toHaveLength(1);
    expect(h.provider.calls.filter((req) => req.maxTokens === undefined)).toHaveLength(1);
  });

  it('a read that Stop replaced with "Interrupted" does not let a later turn overwrite the file', async () => {
    const controller = new AbortController();
    const tools = getProjectTools({ editMode: 'auto' }).map((tool) =>
      tool.spec.name !== 'read_file'
        ? tool
        : {
            ...tool,
            run: async (...args: Parameters<typeof tool.run>) => {
              const result = await tool.run(...args);
              expect(result.ok).toBe(true);
              controller.abort();
              return result;
            },
          },
    );
    h = await createHarness({
      script: (_, i) =>
        i === 0
          ? calls(['read_file', { path: 'a.txt' }])
          : i === 1
            ? calls(['write_file', { path: 'a.txt', content: 'overwrite\n' }])
            : reply,
      tools,
      changes: s.svc,
      projectRoot: s.root,
    });
    await h.chats.update(h.chatId, { title: 'Test', editMode: 'auto' });
    const stopped = await h.run({ signal: controller.signal });
    expect(results(stopped)).toMatchObject([{ ok: false, summary: 'Interrupted' }]);
    const next = await h.run({ newUserMessage: { text: 'go on', attachmentIds: [] } });
    expect(results(next)).toMatchObject([{ ok: false, output: autoUnreadText('a.txt') }]);
    expect(await s.read('a.txt')).toBe('original\n');
  });
});

describe('Retry failures and chats without a project', () => {
  const editA = (_: unknown, i: number) =>
    i === 0 ? calls(['edit_file', { path: 'a.txt', old_string: 'original', new_string: 'changed' }]) : reply;

  it('a failing undo keeps the history and the files and reports the error', async () => {
    await setup(editA);
    await h.run();
    const before = h.messages();
    const restore = vi.spyOn(s.svc, 'restore');
    vi.spyOn(s.svc, 'prepareRetry').mockRejectedValueOnce(new Error('store unreadable'));
    const modelCalls = h.provider.calls.length;
    const events = await h.run({ newUserMessage: undefined });
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(h.messages()).toEqual(before);
    expect(await s.read('a.txt')).toBe('changed\n');
    expect(restore).not.toHaveBeenCalled();
    expect(h.provider.calls).toHaveLength(modelCalls);
    expect((await s.svc.get(h.chatId)).applied[0]?.undo).toBeUndefined();
  });

  it('a failing restore after the undo still keeps the skipped-file note', async () => {
    await s.seed('b.txt', 'before\n');
    await setup((_, i) =>
      i === 0
        ? calls(
            ['edit_file', { path: 'b.txt', old_string: 'before', new_string: 'after' }],
            ['edit_file', { path: 'a.txt', old_string: 'original', new_string: 'changed' }],
          )
        : reply,
    );
    await h.run();
    await s.seed('a.txt', 'user edit\n');
    vi.spyOn(s.svc, 'restore').mockRejectedValueOnce(new Error('store unwritable'));
    const events = await h.run({ newUserMessage: undefined });
    const undo = { restored: ['b.txt'], skipped: [{ path: 'a.txt', reason: 'changed_since' as const }] };
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.some((e) => e.type === 'auto_batch_updated')).toBe(true);
    expect(events.some((e) => e.type === 'chat_updated')).toBe(true);
    expect(h.messages().find((m) => m.role === 'user')).toMatchObject({ changesNote: retryUndoNote(undo) });
    expect(await s.read('b.txt')).toBe('before\n');
    expect(await s.read('a.txt')).toBe('user edit\n');
  });

  it('retry in a loose chat neither undoes nor restores and answers again', async () => {
    h = await createHarness({ script: () => reply, project: false, changes: s.svc, getProjectTools });
    await h.chats.update(h.chatId, { title: 'Test', editMode: 'auto' });
    await h.run();
    const prepare = vi.spyOn(s.svc, 'prepareRetry');
    const restore = vi.spyOn(s.svc, 'restore');
    const events = await h.run({ newUserMessage: undefined });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(h.messages().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h.provider.calls.at(-1)?.tools).toBeUndefined();
  });

  it.each([
    ['detached from the chat', true],
    ['still named by the chat', false],
  ])('retry after the project was deleted (%s) undoes nothing and answers without tools', async (_, detach) => {
    await setup(editA);
    await h.run();
    expect(await s.read('a.txt')).toBe('changed\n');
    await h.projects.remove(PROJECT.id);
    if (detach) await h.chats.detachProject(PROJECT.id);
    const prepare = vi.spyOn(s.svc, 'prepareRetry');
    const events = await h.run({ newUserMessage: undefined });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'auto_batch_updated')).toBe(false);
    expect(await s.read('a.txt')).toBe('changed\n');
    expect((await s.svc.get(h.chatId)).applied[0]?.undo).toBeUndefined();
    expect(h.messages().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h.provider.calls.at(-1)?.tools).toBeUndefined();
  });
});
