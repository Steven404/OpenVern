import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { CHAT_PROJECT_CHANGED, RETRY_OTHER_PROJECT } from '@shared/api';
import type { AgentEvent } from '@shared/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AutoSetup, setupAuto } from '../changes/auto-test-helpers';
import { sha256 } from '../changes/blobs';
import type { FakeScript, FakeStep } from '../providers/fake';
import { getProjectTools } from '../tools';
import type { GetProjectTools } from '../tools/types';
import type { TurnChanges } from '../types';
import {
  autoStaleText,
  autoUnreadText,
  autoUnsavedText,
  editPromptLines,
  editToolDescriptions,
  modeChangedNote,
  retryUndoNote,
  retryUndoNotice,
} from './edit-mode';
import { INTERRUPTED_OUTPUT } from './history';
import { TOOL_CALL_IDS_ERROR } from './loop';
import { createHarness, type Harness, PROJECT } from './test-helpers';

const reply: FakeStep[] = [
  { type: 'text_delta', delta: 'Done' },
  { type: 'finish', reason: 'stop' },
];
/** Model responses scripted so far in this test: a call ID is never reused in a chat, as the loop requires. */
let responses = 0;
const calls = (...items: [string, object][]): FakeStep[] => {
  const n = responses++;
  return [
    ...items.map(
      ([name, args], i): FakeStep => ({
        type: 'tool_call',
        call: { id: `call-${n}-${i}`, name, argsJson: JSON.stringify(args) },
      }),
    ),
    { type: 'finish', reason: 'tool_calls' },
  ];
};
let s: AutoSetup;
let h: Harness;
beforeEach(async () => {
  responses = 0;
  s = await setupAuto({ secondProject: true });
  await s.seed('a.txt', 'original\n');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(path.dirname(s.root), { recursive: true, force: true });
});
async function setup(script: FakeScript, auto = true, tools: GetProjectTools = getProjectTools) {
  h = await createHarness({ script, changes: s.svc, projectRoot: s.root, getProjectTools: tools });
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
      const wrapped: TurnChanges = {
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

  it('a read whose result couldn’t be saved to the chat does not let a later turn overwrite the file', async () => {
    await setup((_, i) =>
      i === 0
        ? calls(['read_file', { path: 'a.txt' }])
        : i === 1
          ? calls(['write_file', { path: 'a.txt', content: 'overwrite\n' }])
          : reply,
    );
    const append = h.chats.appendMessage.bind(h.chats);
    let failing = true;
    vi.spyOn(h.chats, 'appendMessage').mockImplementation(async (chatId, message) => {
      if (failing && message.role === 'tool' && message.name === 'read_file') {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return append(chatId, message);
    });
    const first = await h.run();
    expect(first.some((e) => e.type === 'error')).toBe(true);
    expect(h.messages().filter((m) => m.role === 'tool')).toEqual([]);

    failing = false;
    const next = await h.run({ newUserMessage: { text: 'go on', attachmentIds: [] } });
    // The model is told the read was interrupted, so it must not count as seen.
    const replayed = h.provider.calls[1]?.messages.find((m) => m.role === 'tool');
    expect(replayed).toMatchObject({ role: 'tool', content: INTERRUPTED_OUTPUT });
    expect(results(next)).toMatchObject([{ ok: false, output: autoUnreadText('a.txt') }]);
    expect(await s.read('a.txt')).toBe('original\n');
  });

  describe('a read authorizes writes only from the next model step', () => {
    /** Turn 1 reads a.txt; then the user changes it; turn 2 runs `same` (read plus a change, in one response). */
    async function readThenUserEdit(same: [string, object][]) {
      await setup((_, i) => (i === 0 ? calls(['read_file', { path: 'a.txt' }]) : i === 2 ? calls(...same) : reply));
      await h.run();
      await s.seed('a.txt', 'user edit\n');
      return results(await h.run({ newUserMessage: { text: 'go on', attachmentIds: [] } }));
    }

    it('a write in the same response as a read is refused as stale when the user changed the file since an earlier read', async () => {
      const out = await readThenUserEdit([
        ['read_file', { path: 'a.txt' }],
        ['write_file', { path: 'a.txt', content: 'overwrite\n' }],
      ]);
      expect(out).toMatchObject([
        { name: 'read_file', ok: true },
        { ok: false, output: autoStaleText('a.txt') },
      ]);
      expect(await s.read('a.txt')).toBe('user edit\n');
    });

    it('a delete in the same response as a read is refused as stale when the user changed the file since an earlier read', async () => {
      const out = await readThenUserEdit([
        ['read_file', { path: 'a.txt' }],
        ['delete_file', { path: 'a.txt' }],
      ]);
      expect(out).toMatchObject([
        { name: 'read_file', ok: true },
        { ok: false, output: autoStaleText('a.txt') },
      ]);
      expect(await s.read('a.txt')).toBe('user edit\n');
    });

    it('an edit in the same response as a read is still refused when the earlier read is stale', async () => {
      const out = await readThenUserEdit([
        ['read_file', { path: 'a.txt' }],
        ['edit_file', { path: 'a.txt', old_string: 'user edit', new_string: 'model edit' }],
      ]);
      expect(out).toMatchObject([
        { name: 'read_file', ok: true },
        { ok: false, output: autoStaleText('a.txt') },
      ]);
      expect(await s.read('a.txt')).toBe('user edit\n');
    });

    it('a read and a write in the same response with no earlier read: the write is refused as unread', async () => {
      await setup((_, i) =>
        i === 0
          ? calls(['read_file', { path: 'a.txt' }], ['write_file', { path: 'a.txt', content: 'overwrite\n' }])
          : reply,
      );
      const out = results(await h.run());
      expect(out).toMatchObject([
        { name: 'read_file', ok: true },
        { ok: false, output: autoUnreadText('a.txt') },
      ]);
      expect(await s.read('a.txt')).toBe('original\n');
    });

    it('a read in step 1 lets a write in step 2 of the same turn through', async () => {
      await setup((_, i) =>
        i === 0
          ? calls(['read_file', { path: 'a.txt' }])
          : i === 1
            ? calls(['write_file', { path: 'a.txt', content: 'overwrite\n' }])
            : reply,
      );
      expect(results(await h.run())).toMatchObject([{ ok: true }, { name: 'write_file', ok: true }]);
      expect(await s.read('a.txt')).toBe('overwrite\n');
    });

    it('a write after a read in the same step leaves its own bytes as seen, so the next step can write again', async () => {
      await setup((_, i) =>
        i === 0
          ? calls(['read_file', { path: 'a.txt' }])
          : i === 1
            ? calls(['read_file', { path: 'a.txt' }], ['write_file', { path: 'a.txt', content: 'second\n' }])
            : i === 2
              ? calls(['write_file', { path: 'a.txt', content: 'third\n' }])
              : reply,
      );
      expect(results(await h.run()).map((r) => r.ok)).toEqual([true, true, true, true]);
      expect(await s.read('a.txt')).toBe('third\n');
    });

    it('when a step’s second read can’t be saved, its first read still lets a later turn write', async () => {
      await s.seed('b.txt', 'bee\n');
      await setup((_, i) =>
        i === 0
          ? calls(['read_file', { path: 'a.txt' }], ['read_file', { path: 'b.txt' }])
          : i === 1
            ? calls(
                ['write_file', { path: 'a.txt', content: 'overwrite\n' }],
                ['write_file', { path: 'b.txt', content: 'overwrite\n' }],
              )
            : reply,
      );
      const append = h.chats.appendMessage.bind(h.chats);
      let failing = true;
      vi.spyOn(h.chats, 'appendMessage').mockImplementation(async (chatId, message) => {
        if (failing && message.role === 'tool' && message.toolCallId === 'call-0-1') {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        return append(chatId, message);
      });
      const first = await h.run();
      expect(first.some((e) => e.type === 'error')).toBe(true);
      expect(h.messages().filter((m) => m.role === 'tool')).toMatchObject([{ toolCallId: 'call-0-0', ok: true }]);

      failing = false;
      const next = await h.run({ newUserMessage: { text: 'go on', attachmentIds: [] } });
      expect(results(next)).toMatchObject([{ ok: true }, { ok: false, output: autoUnreadText('b.txt') }]);
      expect(await s.read('a.txt')).toBe('overwrite\n');
      expect(await s.read('b.txt')).toBe('bee\n');
    });

    it('a read held for the end of its step keeps the digest of what it read, never the bytes', async () => {
      // The tool's buffer is wiped once the read is noted: a read held by reference would be recorded as all zeros at
      // the end of the step, and the write a step later refused as stale.
      const wipeAfterNote: GetProjectTools = (o) =>
        getProjectTools(o).map((tool) =>
          tool.spec.name !== 'read_file'
            ? tool
            : {
                ...tool,
                run: (args, ctx) => {
                  const changes = ctx.changes;
                  if (!changes) return tool.run(args, ctx);
                  const noteRead = (p: string, bytes: Uint8Array) => {
                    changes.noteRead(p, bytes);
                    bytes.fill(0);
                  };
                  return tool.run(args, { ...ctx, changes: { ...changes, noteRead } });
                },
              },
        );
      const original = s.svc.tools.bind(s.svc);
      const recorded: [string, string][] = [];
      vi.spyOn(s.svc, 'tools').mockImplementation((input) => {
        const inner = original(input);
        const wrapped: TurnChanges = {
          ...inner,
          noteRead: () => {
            throw new Error('the loop hands the change service a digest, not the bytes');
          },
          noteReadHash: (p, hash) => {
            recorded.push([p, hash]);
            inner.noteReadHash(p, hash);
          },
        };
        return wrapped;
      });
      await setup(
        (_, i) =>
          i === 0
            ? calls(['read_file', { path: 'a.txt' }])
            : i === 1
              ? calls(['write_file', { path: 'a.txt', content: 'overwrite\n' }])
              : reply,
        true,
        wipeAfterNote,
      );
      expect(results(await h.run())).toMatchObject([{ ok: true }, { name: 'write_file', ok: true }]);
      expect(recorded).toEqual([['a.txt', sha256(Buffer.from('original\n'))]]);
      expect(await s.read('a.txt')).toBe('overwrite\n');
    });
  });

  describe('every tool call of a response needs an ID of its own, or none of them runs', () => {
    const withIds = (...items: [string, string, object][]): FakeStep[] => [
      ...items.map(
        ([id, name, args]): FakeStep => ({ type: 'tool_call', call: { id, name, argsJson: JSON.stringify(args) } }),
      ),
      { type: 'finish', reason: 'tool_calls' },
    ];
    /** Runs `response` as the first step, then a turn that overwrites a.txt, which needs a read of it first. */
    async function refusedThenOverwrite(response: FakeStep[]) {
      await setup((_, i) =>
        i === 0 ? response : i === 1 ? calls(['write_file', { path: 'a.txt', content: 'overwrite\n' }]) : reply,
      );
      const first = await h.run();
      expect(first.filter((e) => e.type === 'tool_call' || e.type === 'tool_result')).toEqual([]);
      expect(first.filter((e) => e.type === 'error')).toMatchObject([
        { error: { code: 'provider_error', message: TOOL_CALL_IDS_ERROR } },
      ]);
      expect(h.messages().filter((m) => m.role === 'tool')).toEqual([]);
      expect(h.messages().at(-1)).toMatchObject({ role: 'assistant', status: 'error', toolCalls: [] });
      expect(h.provider.calls).toHaveLength(1);
      expect(await s.exists('new.txt')).toBe(false);
      // Nothing counts as read: the overwrite on the next turn is refused.
      const next = results(await h.run({ newUserMessage: { text: 'go on', attachmentIds: [] } }));
      expect(next).toMatchObject([{ ok: false, output: autoUnreadText('a.txt') }]);
      expect(await s.read('a.txt')).toBe('original\n');
    }

    it('a call with an empty ID: no call of the response runs', async () => {
      await refusedThenOverwrite(
        withIds(['', 'read_file', { path: 'a.txt' }], ['w', 'write_file', { path: 'new.txt', content: 'new' }]),
      );
    });

    it('two calls sharing an ID: no call of the response runs', async () => {
      await refusedThenOverwrite(
        withIds(['dup', 'read_file', { path: 'a.txt' }], ['dup', 'write_file', { path: 'new.txt', content: 'new' }]),
      );
    });

    it('two reads sharing an ID, then Stop: the next turn can’t overwrite the file whose content it never got back', async () => {
      await s.seed('b.txt', 'bee\n');
      const controller = new AbortController();
      await setup((_, i) =>
        i === 0
          ? withIds(['same', 'read_file', { path: 'a.txt' }], ['same', 'read_file', { path: 'b.txt' }])
          : i === 1
            ? calls(['write_file', { path: 'a.txt', content: 'overwrite\n' }])
            : reply,
      );
      // Stop lands once the second read's result is in the chat, before the next model request.
      const save = h.chats.appendMessage.bind(h.chats);
      vi.spyOn(h.chats, 'appendMessage').mockImplementation(async (chatId, message) => {
        const saved = await save(chatId, message);
        if (message.role === 'tool' && message.output.includes('bee')) controller.abort();
        return saved;
      });
      await h.run({ signal: controller.signal });
      expect(h.provider.calls).toHaveLength(1);

      const next = await h.run({ newUserMessage: { text: 'go on', attachmentIds: [] } });
      // Whatever the replay showed for the first call, a.txt's content didn't reach the model as such.
      expect(results(next)).toMatchObject([{ ok: false, output: autoUnreadText('a.txt') }]);
      expect(await s.read('a.txt')).toBe('original\n');
    });

    it('a call reusing an ID from an earlier step: no call of the response runs', async () => {
      await s.seed('b.txt', 'bee\n');
      await setup((_, i) =>
        i === 0
          ? withIds(['x', 'read_file', { path: 'a.txt' }])
          : i === 1
            ? withIds(['x', 'read_file', { path: 'b.txt' }])
            : i === 2
              ? calls(['write_file', { path: 'b.txt', content: 'overwrite\n' }])
              : reply,
      );
      const first = await h.run();
      expect(results(first)).toMatchObject([{ name: 'read_file', ok: true }]);
      expect(first.filter((e) => e.type === 'error')).toMatchObject([{ error: { message: TOOL_CALL_IDS_ERROR } }]);
      expect(h.messages().filter((m) => m.role === 'tool')).toHaveLength(1);
      const next = results(await h.run({ newUserMessage: { text: 'go on', attachmentIds: [] } }));
      expect(next).toMatchObject([{ ok: false, output: autoUnreadText('b.txt') }]);
      expect(await s.read('b.txt')).toBe('bee\n');
    });
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

  it('retry after the project was deleted (detached from the chat) undoes nothing and answers without tools', async () => {
    await setup(editA);
    await h.run();
    expect(await s.read('a.txt')).toBe('changed\n');
    await h.projects.remove(PROJECT.id);
    await h.chats.detachProject(PROJECT.id);
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

describe('the turn’s project, and a retry after a move', () => {
  const editA = (_: unknown, i: number) =>
    i === 0 ? calls(['edit_file', { path: 'a.txt', old_string: 'original', new_string: 'changed' }]) : reply;

  it('a retry in B of a turn whose writes are still undoable in A is refused before anything is stored', async () => {
    await setup(editA);
    await h.run();
    expect(await s.read('a.txt')).toBe('changed\n');
    const projectB = await h.projects.create({ rootPath: s.rootB ?? '' });
    await s.svc.changeProject(h.chatId, async () => {
      await h.chats.update(h.chatId, { projectId: projectB.id });
    });
    const before = h.messages();
    const prepare = vi.spyOn(s.svc, 'prepareRetry');
    const note = vi.spyOn(h.chats, 'setChangesNote');
    const truncate = vi.spyOn(h.chats, 'truncateAfterLastUser');
    const modelCalls = h.provider.calls.length;
    const events = await h.run({ newUserMessage: undefined, projectId: projectB.id });
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ code: 'conflict', message: RETRY_OTHER_PROJECT }),
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(prepare).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(truncate).not.toHaveBeenCalled();
    expect(h.messages()).toEqual(before);
    expect(h.provider.calls).toHaveLength(modelCalls);
    expect(await s.read('a.txt')).toBe('changed\n');
    expect((await s.svc.get(h.chatId)).applied[0]).not.toHaveProperty('undo');
  });

  it('retry after the project was deleted (still named by the chat) fails before anything is undone or truncated', async () => {
    await setup(editA);
    await h.run();
    await h.projects.remove(PROJECT.id);
    const before = h.messages();
    const prepare = vi.spyOn(s.svc, 'prepareRetry');
    const truncate = vi.spyOn(h.chats, 'truncateAfterLastUser');
    const events = await h.run({ newUserMessage: undefined });
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ code: 'conflict', message: CHAT_PROJECT_CHANGED }),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(truncate).not.toHaveBeenCalled();
    expect(h.messages()).toEqual(before);
    expect(await s.read('a.txt')).toBe('changed\n');
    expect((await s.svc.get(h.chatId)).applied[0]).not.toHaveProperty('undo');
  });

  it('a send pinned to a project removed since the route read it fails before anything is stored', async () => {
    const takeNote = vi.spyOn(s.svc, 'takeNote');
    const snapshot = vi.spyOn(s.svc, 'snapshot');
    await setup(() => reply);
    const att = h.attachments.add({ name: 'notes.txt', content: 'notes' });
    await h.projects.remove(PROJECT.id);
    const events = await h.run({
      projectId: PROJECT.id,
      newUserMessage: { text: 'hello', attachmentIds: [att.id] },
    });
    expect(events).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ code: 'conflict', message: CHAT_PROJECT_CHANGED }),
    });
    expect(h.messages()).toEqual([]);
    expect(h.attachments.bound.has(att.id)).toBe(false);
    expect(takeNote).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(h.provider.calls).toHaveLength(0);
  });

  it('Stop during a write whose change history couldn’t be saved keeps the real result and announces the batch', async () => {
    const controller = new AbortController();
    let failSave = false;
    s.hooks.beforeWrite = () => {
      failSave = true;
      controller.abort();
    };
    s.hooks.beforeStoreWrite = () => {
      if (!failSave) return;
      failSave = false;
      throw new Error('disk full');
    };
    await setup((_, i) => (i === 0 ? calls(['write_file', { path: 'new.txt', content: 'real write' }]) : reply));
    const events = await h.run({ signal: controller.signal });
    expect(controller.signal.aborted).toBe(true);
    expect(await s.read('new.txt')).toBe('real write');
    const result = { ok: true, output: `Created new.txt (1 line). Written to disk.\n${autoUnsavedText()}` };
    expect(results(events)).toMatchObject([result]);
    expect(h.messages().find((m) => m.role === 'tool')).toMatchObject(result);
    expect(events.filter((e) => e.type === 'auto_batch_updated')).toHaveLength(1);
  });
});

describe('a write is never hidden when both the change history and the chat can’t be saved', () => {
  /** After the project file changed: the change history's save and the chat's appends fail until `recover()`. */
  function failStorageAfterTheWrite(controller?: AbortController) {
    let failing = false;
    s.hooks.beforeWrite = () => {
      failing = true;
      controller?.abort();
    };
    s.hooks.beforeStoreWrite = () => {
      if (failing) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    const append = h.chats.appendMessage.bind(h.chats);
    vi.spyOn(h.chats, 'appendMessage').mockImplementation(async (chatId, message) => {
      if (failing) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return append(chatId, message);
    });
    return {
      recover: () => {
        failing = false;
        s.hooks.beforeWrite = undefined;
      },
    };
  }
  const written = { ok: true, output: `Created new.txt (1 line). Written to disk.\n${autoUnsavedText()}` };

  it('Stop: the client gets the real result and the batch, and the next turn records it before the model sees it', async () => {
    const controller = new AbortController();
    await setup((_, i) => (i === 0 ? calls(['write_file', { path: 'new.txt', content: 'real write' }]) : reply));
    const storage = failStorageAfterTheWrite(controller);
    const events = await h.run({ signal: controller.signal });
    expect(controller.signal.aborted).toBe(true);
    expect(await s.read('new.txt')).toBe('real write');
    expect(results(events)).toMatchObject([written]);
    expect(events.filter((e) => e.type === 'auto_batch_updated')).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(h.messages().filter((m) => m.role === 'tool')).toEqual([]);

    storage.recover();
    await h.run({ newUserMessage: { text: 'next', attachmentIds: [] } });
    expect(h.messages().filter((m) => m.role === 'tool')).toMatchObject([written]);
    const replayed = h.provider.calls.at(-1)?.messages.find((m) => m.role === 'tool');
    expect(replayed).toMatchObject({ role: 'tool', content: written.output });
    // The change history was saved by the next store operation.
    expect((await s.svc.get(h.chatId)).applied.map((b) => b.written.map((f) => f.path))).toEqual([['new.txt']]);
  });

  it('while the chat still can’t be saved, the next turn fails before anything of its own is stored', async () => {
    await setup((_, i) => (i === 0 ? calls(['write_file', { path: 'new.txt', content: 'real write' }]) : reply));
    failStorageAfterTheWrite();
    await h.run();
    const before = h.messages();
    const modelCalls = h.provider.calls.length;
    const events = await h.run({ newUserMessage: { text: 'next', attachmentIds: [] } });
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'user_message')).toBe(false);
    expect(h.messages()).toEqual(before);
    expect(h.provider.calls).toHaveLength(modelCalls);
  });

  it('a retry of that turn records the result, then undoes the write and drops the attempt', async () => {
    await setup((_, i) => (i === 0 ? calls(['write_file', { path: 'new.txt', content: 'real write' }]) : reply));
    const storage = failStorageAfterTheWrite();
    await h.run();
    storage.recover();
    const events = await h.run({ newUserMessage: undefined });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(await s.exists('new.txt')).toBe(false);
    expect(h.messages().filter((m) => m.role === 'tool')).toEqual([]);
  });
});

describe('a retry’s mode line is made true for the mode it runs in', () => {
  const lastUserNote = () => h.messages().findLast((m) => m.role === 'user')?.changesNote;

  it('an Auto turn retried in Review loses its Auto line and keeps its undo block', async () => {
    await setup((_, i) =>
      i === 0 ? calls(['edit_file', { path: 'a.txt', old_string: 'original', new_string: 'changed' }]) : reply,
    );
    await h.run(); // Auto, writes a.txt
    await h.chats.update(h.chatId, { editMode: 'review' });
    await h.run({ newUserMessage: { text: 'two', attachmentIds: [] } });
    const batchId = (await s.svc.get(h.chatId)).applied[0]?.id ?? '';
    await s.svc.undoBatch({ chatId: h.chatId, projectId: PROJECT.id, projectRoot: s.root, batchId });
    await h.chats.update(h.chatId, { editMode: 'auto' });
    await h.run({ newUserMessage: { text: 'three', attachmentIds: [] } });
    const autoLine = modeChangedNote('auto');
    const sent = lastUserNote() ?? '';
    expect(sent.startsWith(`${autoLine}\n\n`)).toBe(true);
    const undoBlock = sent.slice(autoLine.length + 2);
    expect(undoBlock).toContain('undid your edits');

    await h.chats.update(h.chatId, { editMode: 'review' });
    await h.run({ newUserMessage: undefined });
    expect(lastUserNote()).toBe(undoBlock);
    const lastRequest = h.provider.calls.at(-1)?.messages ?? [];
    const lastUser = lastRequest.findLast((m) => m.role === 'user');
    expect(JSON.stringify(lastUser)).not.toContain('Edit mode changed since your last reply: Auto');
    expect(JSON.stringify(lastUser)).toContain(JSON.stringify(undoBlock).slice(1, 40));
  });

  it('a Review turn retried in Auto gains the Auto line', async () => {
    await setup(() => reply, false);
    await h.run();
    await h.run({ newUserMessage: { text: 'two', attachmentIds: [] } });
    expect(lastUserNote()).toBeUndefined();
    await h.chats.update(h.chatId, { editMode: 'auto' });
    await h.run({ newUserMessage: undefined });
    expect(lastUserNote()).toBe(modeChangedNote('auto'));
    expect(JSON.stringify(h.provider.calls.at(-1)?.messages)).toContain(
      'Edit mode changed since your last reply: Auto',
    );
  });
});
