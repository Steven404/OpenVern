import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '@shared/events';
import type { UserMessage } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeProvider, type FakeStep, scriptFromTurns, textDeltas } from '../providers/fake';
import { getProjectTools } from '../tools';
import { createFakeChangesService } from '../tools/test-changes';
import { createFixture, type Fixture } from '../tools/test-fixture';
import { buildHistory } from './history';
import { createHarness, MODEL, model, shape } from './test-helpers';

let fx: Fixture;
beforeAll(async () => {
  fx = await createFixture();
});
afterAll(async () => {
  await fx.cleanup();
});

const reply = (text: string): FakeStep[] => [...textDeltas(text, 50), { type: 'finish', reason: 'stop' }];
const callTools = (calls: [id: string, name: string, args: object][]): FakeStep[] => [
  ...calls.map(([id, name, a]): FakeStep => ({ type: 'tool_call', call: { id, name, argsJson: JSON.stringify(a) } })),
  { type: 'finish', reason: 'tool_calls' },
];
const TITLE = reply('Title');

async function setup(script: FakeStep[][], opts: { project?: boolean; tools?: boolean; changes?: boolean } = {}) {
  const changes = createFakeChangesService();
  const h = await createHarness({
    script: scriptFromTurns([...script, TITLE]),
    tools: getProjectTools(),
    projectRoot: fx.root,
    models: [model(MODEL, { tools: opts.tools ?? true })],
    ...(opts.project === false ? { project: false } : {}),
    ...(opts.changes === false ? {} : { changes }),
  });
  return { h, changes };
}
const toolNames = (h: { provider: { calls: { tools?: { name: string }[] }[] } }) =>
  h.provider.calls[0]?.tools?.map((t) => t.name) ?? [];

describe('edit tools in the agent loop', () => {
  it('stages edits, emits changes_updated right after each tool_result, never touches the disk', async () => {
    const { h } = await setup([
      callTools([
        ['c1', 'edit_file', { path: 'README.md', old_string: '# Fixture', new_string: '# Edited' }],
        ['c2', 'write_file', { path: 'src/new.ts', content: 'export {};\n' }],
        ['c3', 'delete_file', { path: 'empty.txt' }],
      ]),
      reply('Proposed three changes.'),
    ]);
    const events = await h.run();
    expect(shape(events)).toEqual([
      'user_message',
      'assistant_start',
      'assistant_end',
      'tool_call',
      'tool_result',
      'changes_updated',
      'tool_call',
      'tool_result',
      'changes_updated',
      'tool_call',
      'tool_result',
      'changes_updated',
      'assistant_start',
      'text_delta*',
      'assistant_end',
      'chat_updated',
      'chat_updated',
      'done',
    ]);
    const updates = events.filter(
      (e): e is Extract<AgentEvent, { type: 'changes_updated' }> => e.type === 'changes_updated',
    );
    const stepId = events.find((e) => e.type === 'assistant_start')?.messageId;
    expect(updates.map((u) => u.messageId)).toEqual([stepId, stepId, stepId]);
    expect(updates.map((u) => u.changes?.files.length)).toEqual([1, 2, 3]);
    expect(updates[2]?.changes?.files.map((f) => `${f.kind}:${f.path}`)).toEqual([
      'modify:README.md',
      'delete:empty.txt',
      'create:src/new.ts',
    ]);
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toBe('# Fixture\n\nA tiny project.\n');
    await expect(readFile(path.join(fx.root, 'src/new.ts'))).rejects.toThrow();
  });

  it('a failed edit tool call emits no changes_updated', async () => {
    const { h } = await setup([
      callTools([['c1', 'edit_file', { path: 'README.md', old_string: 'nope', new_string: 'x' }]]),
      reply('Could not.'),
    ]);
    const events = await h.run();
    expect(events.some((e) => e.type === 'changes_updated')).toBe(false);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ message: { ok: false } });
  });

  it('later reads in the same turn see the proposal', async () => {
    const { h } = await setup([
      callTools([['c1', 'write_file', { path: 'src/new.ts', content: 'export const z = 1;\n' }]]),
      callTools([['c2', 'read_file', { path: 'src/new.ts' }]]),
      reply('done'),
    ]);
    await h.run();
    const read = h.messages().find((m) => m.role === 'tool' && m.toolCallId === 'c2');
    expect(read).toMatchObject({ ok: true });
    expect(read?.role === 'tool' && read.output).toContain('1 | export const z = 1;');
  });

  it('offers the edit tools and the edit prompt in a project chat with a tools-capable model', async () => {
    const { h } = await setup([reply('hi')]);
    await h.run();
    expect(toolNames(h)).toEqual(['list_files', 'read_file', 'search', 'edit_file', 'write_file', 'delete_file']);
    expect(h.provider.calls[0]?.system).toContain('edit_file');
    expect(h.provider.calls[0]?.system).not.toContain('You cannot modify files');
  });

  it('offers no edit tools in a loose chat, with a tool-less model, or without a change service', async () => {
    const loose = await setup([reply('hi')], { project: false });
    await loose.h.run();
    expect(loose.h.provider.calls[0]?.tools).toBeUndefined();

    const noTools = await setup([reply('hi')], { tools: false });
    await noTools.h.run();
    expect(noTools.h.provider.calls[0]?.tools).toBeUndefined();

    const noSvc = await setup([reply('hi')], { changes: false });
    await noSvc.h.run();
    expect(toolNames(noSvc.h)).toEqual(['list_files', 'read_file', 'search']);
    expect(noSvc.h.provider.calls[0]?.system).toContain('cannot modify files');
  });

  it('refuses an edit tool call the model makes when the tool was not offered', async () => {
    const { h } = await setup([callTools([['c1', 'write_file', { path: 'a.txt', content: 'x' }]]), reply('ok')], {
      changes: false,
    });
    const events = await h.run();
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ message: { ok: false } });
    expect(events.some((e) => e.type === 'changes_updated')).toBe(false);
  });

  it('snapshots at a new user message and restores on retry', async () => {
    const { h, changes } = await setup([
      callTools([['c1', 'write_file', { path: 'src/new.ts', content: 'x\n' }]]),
      reply('done'),
    ]);
    await h.run();
    const user = h.messages().find((m) => m.role === 'user');
    expect(changes.log).toEqual(['takeNote', `snapshot:${user?.id}`]);
    expect(changes.pending.get(h.chatId)?.size).toBe(1);

    // The retry puts the proposal back to what it was before the first turn (empty); the scripted retry only replies.
    await h.run({ newUserMessage: undefined });
    expect(changes.log).toContain(`restore:${user?.id}`);
    expect(changes.log.filter((l) => l.startsWith('snapshot')).length).toBe(1);
    expect(changes.pending.get(h.chatId)?.size).toBe(0);
  });

  it('puts the note on the new user message and replays it to the provider only', async () => {
    const { h, changes } = await setup([reply('hi')]);
    changes.nextNote = '[OpenVern] Since your last reply the user reviewed your proposed edits:\n- Written: a.ts';
    const events = await h.run();
    const um = events.find((e) => e.type === 'user_message');
    const msg = um?.type === 'user_message' ? (um.message as UserMessage) : undefined;
    expect(msg?.text).toBe('Hello there');
    expect(msg?.changesNote).toContain('Written: a.ts');
    const sent = h.provider.calls[0]?.messages[0];
    expect(sent?.role === 'user' && sent.content.map((p) => (p.type === 'text' ? p.text : '')).join('')).toBe(
      'Hello there\n\n[OpenVern] Since your last reply the user reviewed your proposed edits:\n- Written: a.ts',
    );

    // A second turn replays the earlier note from the stored message.
    changes.nextNote = undefined;
    await h.run({ newUserMessage: { text: 'And now?', attachmentIds: [] } });
    const second = h.provider.calls.find((c) => c.messages.length > 1 && c.maxTokens === undefined);
    const first = second?.messages[0];
    expect(first?.role === 'user' && JSON.stringify(first.content)).toContain('Written: a.ts');
  });

  it('buildHistory appends changesNote to the text, or uses it alone for an empty message', async () => {
    const base = { id: 'u', role: 'user' as const, createdAt: '', attachments: [] };
    const out = await buildHistory(
      [
        { ...base, text: 'hi', changesNote: 'NOTE' },
        { ...base, text: '', changesNote: 'ONLY' },
      ],
      { model: MODEL, supportsImages: false, toolsOffered: false, readAttachment: async () => new Uint8Array() },
    );
    expect(out).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi\n\nNOTE' }] },
      { role: 'user', content: [{ type: 'text', text: 'ONLY' }] },
    ]);
  });
});

describe('fake provider edit markers', () => {
  it('a scripted turn proposes three files and changes nothing on disk', async () => {
    const changes = createFakeChangesService();
    const h = await createHarness({
      script: () => [],
      provider: createFakeProvider({ delayMs: 0 }),
      tools: getProjectTools(),
      projectRoot: fx.root,
      changes,
    });
    const events = await h.run({
      newUserMessage: {
        text: 'Do it [fake:edit=README.md] [fake:write=src/made-by-fake.ts] [fake:delete=empty.txt]',
        attachmentIds: [],
      },
    });
    expect(events.filter((e) => e.type === 'changes_updated')).toHaveLength(3);
    const pending = changes.pending.get(h.chatId);
    expect([...(pending?.keys() ?? [])].sort()).toEqual(['README.md', 'empty.txt', 'src/made-by-fake.ts']);
    expect(pending?.get('README.md')?.content).toBe('# Fixture // edited by the fake provider\n\nA tiny project.\n');
    expect(events.at(-1)?.type).toBe('done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    await expect(readFile(path.join(fx.root, 'src/made-by-fake.ts'))).rejects.toThrow();
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toBe('# Fixture\n\nA tiny project.\n');
  });
});
