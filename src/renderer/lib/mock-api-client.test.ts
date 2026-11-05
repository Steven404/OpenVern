import { LIMITS, NEW_CHAT_TITLE } from '@shared/constants';
import type { AgentEvent } from '@shared/events';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client';
import { MockApiClient } from './mock-api-client';

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

async function collectUntil(
  iter: AsyncIterable<AgentEvent>,
  ctrl: AbortController,
  pred: (e: AgentEvent) => boolean,
): Promise<{ events: AgentEvent[]; error: unknown }> {
  const events: AgentEvent[] = [];
  let error: unknown;
  try {
    for await (const e of iter) {
      events.push(e);
      if (pred(e)) ctrl.abort();
    }
  } catch (err) {
    error = err;
  }
  return { events, error };
}

describe('MockApiClient', () => {
  it('is seeded with the design sample data', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const projects = await api.listProjects();
    expect(projects.map((p) => [p.name, p.chatCount])).toEqual([
      ['Offline Notes App', 2],
      ['Portfolio site', 1],
      ['stefanos-ai-openvern', 3],
    ]);
    const chats = await api.listChats();
    expect(chats).toHaveLength(6);
    const first = chats.find((c) => c.title === 'Agent loop and tool calls');
    const chat = await api.getChat(first?.id ?? '');
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('streams a tool turn in the documented order', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const [project] = await api.listProjects();
    const chat = await api.createChat({ projectId: project?.id ?? null, model: 'anthropic/claude-sonnet-5.5' });
    const events = await collect(
      api.sendMessage(chat.id, { text: 'Explain', attachmentIds: [], model: chat.model }, new AbortController().signal),
    );
    const types = events.map((e) => e.type).filter((t) => t !== 'text_delta');
    expect(types).toEqual([
      'user_message',
      'assistant_start',
      'assistant_end',
      'tool_call',
      'tool_result',
      'assistant_start',
      'assistant_end',
      'chat_updated',
      'done',
    ]);
    expect((await api.getChat(chat.id)).title).toBe('Explain');
  });

  it('does not offer tools in loose chats', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    const events = await collect(
      api.sendMessage(chat.id, { text: 'hi', attachmentIds: [], model: chat.model }, new AbortController().signal),
    );
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  });

  it('archives and restores a loose chat; the seed starts unarchived', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    expect((await api.listChats()).every((c) => c.archived === false)).toBe(true);
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    expect(chat.archived).toBe(false);

    const archived = await api.updateChat(chat.id, { archived: true });
    expect(archived).toMatchObject({ id: chat.id, archived: true, updatedAt: chat.updatedAt });
    expect((await api.getChat(chat.id)).archived).toBe(true);
    expect((await api.listChats()).find((c) => c.id === chat.id)?.archived).toBe(true);

    const restored = await api.updateChat(chat.id, { archived: false });
    expect(restored.archived).toBe(false);
    expect((await api.getChat(chat.id)).archived).toBe(false);
  });

  it('moving an archived chat into a project and out again keeps it archived', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const [project] = await api.listProjects();
    const chat = await api.createChat({ projectId: null, model: 'm' });
    await api.updateChat(chat.id, { archived: true });

    const stillArchived = await api.updateChat(chat.id, { projectId: null });
    expect(stillArchived.archived).toBe(true);

    const moved = await api.updateChat(chat.id, { projectId: project?.id ?? null });
    expect(moved).toMatchObject({ projectId: project?.id, archived: true });
    expect((await api.getChat(chat.id)).archived).toBe(true);
  });

  it('archive changes during a run throw conflict without applying anything; other edits still work', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const [project] = await api.listProjects();
    const loose = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    const archivedChat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    await api.updateChat(archivedChat.id, { archived: true });

    const runs = [loose, archivedChat].map((c) =>
      api
        .sendMessage(c.id, { text: 'go', attachmentIds: [], model: c.model }, new AbortController().signal)
        [Symbol.asyncIterator](),
    );
    for (const run of runs) await run.next(); // the run is registered once the first event is out

    const wait = 'Wait for the response to finish before archiving or unarchiving this chat.';
    const conflict = async (p: Promise<unknown>) => {
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 409, info: { code: 'conflict', message: wait } });
    };
    const looseBefore = await api.getChat(loose.id);
    await conflict(api.updateChat(loose.id, { title: 'Renamed', archived: true }));
    await conflict(api.updateChat(archivedChat.id, { archived: false }));
    await conflict(
      api.updateChat(archivedChat.id, { title: 'Moved', projectId: project?.id ?? null, archived: false }),
    );
    const archivedNow = await api.getChat(archivedChat.id);
    expect(archivedNow).toMatchObject({ archived: true, projectId: null, title: archivedChat.title });
    expect((await api.getChat(loose.id)).archived).toBe(false);
    expect((await api.getChat(loose.id)).title).toBe(looseBefore.title);

    expect((await api.updateChat(loose.id, { title: 'Renamed' })).title).toBe('Renamed');

    for (const run of runs) await run.return?.(undefined);
    expect((await api.updateChat(loose.id, { archived: true })).archived).toBe(true);
  });

  it('moves chats to "no project" when their project is removed', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const site = (await api.listProjects()).find((p) => p.name === 'Portfolio site');
    await api.deleteProject(site?.id ?? '');
    expect((await api.listChats()).filter((c) => c.projectId === null)).toHaveLength(1);
  });

  it('rejects invalid keys and duplicate projects with ApiError', async () => {
    const api = new MockApiClient({ delayMs: 0, keyConfigured: false });
    await expect(api.listModels()).rejects.toMatchObject({ info: { code: 'no_api_key' } });
    await expect(api.setOpenRouterKey('bad')).rejects.toBeInstanceOf(ApiError);
    const s = await api.setOpenRouterKey('sk-or-v1-0123456789abcdef');
    expect(s.openRouter).toEqual({ configured: true, keyHint: 'sk-or-v1-…cdef' });
    await api.createProject({ rootPath: '/tmp/x' });
    await expect(api.createProject({ rootPath: '/tmp/x/' })).rejects.toMatchObject({ status: 409 });
  });

  it('Stop during text rejects with AbortError and saves the partial reply as stopped', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    const ctrl = new AbortController();
    const { events, error } = await collectUntil(
      api.sendMessage(chat.id, { text: 'go', attachmentIds: [], model: chat.model }, ctrl.signal),
      ctrl,
      (e) => e.type === 'text_delta',
    );
    expect((error as Error | undefined)?.name).toBe('AbortError');
    const last = events.at(-1);
    expect(last?.type).toBe('text_delta');
    const firstDelta = events.find((e) => e.type === 'text_delta');
    const saved = await api.getChat(chat.id);
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(saved.messages.at(-1)).toMatchObject({
      status: 'stopped',
      text: firstDelta?.type === 'text_delta' ? firstDelta.delta : '',
      toolCalls: [],
    });
  });

  it('Stop during a tool rejects and records an Interrupted result, with no extra assistant', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const [project] = await api.listProjects();
    const chat = await api.createChat({ projectId: project?.id ?? null, model: 'anthropic/claude-sonnet-5.5' });
    const ctrl = new AbortController();
    const { events, error } = await collectUntil(
      api.sendMessage(chat.id, { text: 'go', attachmentIds: [], model: chat.model }, ctrl.signal),
      ctrl,
      (e) => e.type === 'tool_call',
    );
    expect((error as Error | undefined)?.name).toBe('AbortError');
    expect(events.at(-1)?.type).toBe('tool_call');
    const saved = await api.getChat(chat.id);
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const [, assistant, tool] = saved.messages;
    expect(assistant).toMatchObject({ status: 'complete' });
    expect(assistant?.role === 'assistant' && assistant.toolCalls).toHaveLength(1);
    expect(tool).toMatchObject({
      ok: false,
      summary: 'Interrupted',
      output: 'Interrupted: the run was stopped before this tool finished.',
    });
    expect(saved.title).toBe(NEW_CHAT_TITLE);
  });

  it('accepts an image/svg+xml file as a text attachment', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const ref = await api.uploadAttachment(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(ref).toMatchObject({ kind: 'text', mime: 'text/plain' });
  });

  describe('uploadAttachment decides by content, like the server', () => {
    const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const upload = (parts: BlobPart[], name: string, type = '') =>
      new MockApiClient({ delayMs: 0 }).uploadAttachment(new File(parts, name, { type }));

    it('rejects an image type the server cannot store (BMP) as unsupported_file', async () => {
      const bmp = new Uint8Array([0x42, 0x4d, 0x36, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0]);
      await expect(upload([bmp], 'pic.bmp', 'image/bmp')).rejects.toMatchObject({
        status: 415,
        info: { code: 'unsupported_file' },
      });
    });

    it('detects a PNG by its magic bytes, whatever file.type says', async () => {
      const ref = await upload([new Uint8Array([...PNG, 0, 0, 0, 13])], 'pic', '');
      expect(ref).toMatchObject({ kind: 'image', mime: 'image/png' });
    });

    it('treats text bytes as text even when file.type claims an image', async () => {
      const ref = await upload(['just text'], 'fake.png', 'image/png');
      expect(ref).toMatchObject({ kind: 'text', mime: 'text/plain' });
    });

    it('rejects binary (NUL) and invalid UTF-8 content', async () => {
      await expect(upload([new Uint8Array([0x61, 0, 0x62])], 'a.txt', 'text/plain')).rejects.toMatchObject({
        info: { code: 'unsupported_file' },
      });
      await expect(upload([new Uint8Array([0xff, 0xfe, 0x41, 0x80])], 'a.txt')).rejects.toMatchObject({
        info: { code: 'unsupported_file' },
      });
    });

    it('uses the same text mime map and size message as the server', async () => {
      expect(await upload(['# hi'], 'README.md')).toMatchObject({ kind: 'text', mime: 'text/markdown' });
      await expect(upload(['a'.repeat(LIMITS.textAttachmentBytes + 1)], 'big.txt')).rejects.toMatchObject({
        status: 413,
        info: {
          code: 'file_too_large',
          message: `This file is too large. The limit for text files is ${LIMITS.textAttachmentBytes / 1024} KB.`,
        },
      });
    });
  });

  describe('v0.2 contracts', () => {
    it('lists a sorted project file tree and reads a file', async () => {
      const api = new MockApiClient({ delayMs: 0 });
      const [project] = await api.listProjects();
      const tree = await api.listProjectFiles(project?.id ?? '');
      expect(tree.truncated).toBe(false);
      expect(tree.entries[0]).toEqual({ path: 'build', type: 'dir' });
      expect(tree.entries.at(-1)?.type).toBe('file');
      const file = await api.readProjectFile(project?.id ?? '', 'README.md');
      expect(file).toMatchObject({ path: 'README.md', binary: false, truncated: false });
      expect(file.content).toContain('OpenVern');
      expect((await api.readProjectFile(project?.id ?? '', 'build/icon.png')).binary).toBe(true);
      await expect(api.readProjectFile(project?.id ?? '', 'nope.txt')).rejects.toBeInstanceOf(ApiError);
      const ref = await api.attachProjectFile(project?.id ?? '', 'README.md');
      expect(ref).toMatchObject({ name: 'README.md', kind: 'text' });
    });

    it('stages the design sample on [mock:edit], then applies only accepted hunks', async () => {
      const api = new MockApiClient({ delayMs: 0 });
      const [project] = await api.listProjects();
      const chat = await api.createChat({ projectId: project?.id ?? null, model: 'anthropic/claude-sonnet-5.5' });
      expect(await api.getChatChanges(chat.id)).toEqual({ pending: null, applied: [] });

      const events = await collect(
        api.sendMessage(
          chat.id,
          { text: 'add write_file [mock:edit]', attachmentIds: [], model: chat.model },
          new AbortController().signal,
        ),
      );
      const updates = events.filter((e) => e.type === 'changes_updated');
      expect(updates).toHaveLength(3);
      const last = updates.at(-1);
      expect(last?.type === 'changes_updated' && last.changes?.files.map((f) => f.path)).toEqual([
        'src/core/tools/write-file.ts',
        'src/core/tools/index.ts',
        'src/shared/constants.ts',
      ]);
      // grammar: every changes_updated directly follows a tool_result
      for (const [i, e] of events.entries()) {
        if (e.type === 'changes_updated') expect(events[i - 1]?.type).toBe('tool_result');
      }

      const { pending } = await api.getChatChanges(chat.id);
      expect(pending?.files.map((f) => f.kind)).toEqual(['create', 'modify', 'modify']);
      expect(pending?.files.reduce((n, f) => n + f.hunks.length, 0)).toBe(4);
      const constants = pending?.files.find((f) => f.path === 'src/shared/constants.ts');
      const c1 = constants?.hunks[0]?.id ?? '';

      await expect(api.applyChatChanges(chat.id, { revision: 0, decisions: {} })).rejects.toMatchObject({
        info: { code: 'changes_stale' },
      });
      const res = await api.applyChatChanges(chat.id, {
        revision: pending?.revision ?? 0,
        decisions: { 'src/shared/constants.ts': { [c1]: 'accepted' } },
      });
      expect(res.batch.written.map((f) => f.path)).toEqual(['src/shared/constants.ts']);
      expect(res.batch.skippedHunks).toBe(3);
      expect(res.changes.pending).toBeNull();
      expect(res.changes.applied).toHaveLength(1);
    });

    it('discards pending changes', async () => {
      const api = new MockApiClient({ delayMs: 0 });
      const [project] = await api.listProjects();
      const chat = await api.createChat({ projectId: project?.id ?? null, model: 'anthropic/claude-sonnet-5.5' });
      await collect(
        api.sendMessage(
          chat.id,
          { text: '[mock:edit]', attachmentIds: [], model: chat.model },
          new AbortController().signal,
        ),
      );
      expect((await api.getChatChanges(chat.id)).pending).not.toBeNull();
      expect(await api.discardChatChanges(chat.id)).toEqual({ pending: null, applied: [] });
    });
  });
});

describe('MockApiClient usage (F1)', () => {
  const ZERO = { contextTokens: 0, promptTokens: 0, completionTokens: 0, costUsd: null, requests: 0 };
  const MODEL = 'anthropic/claude-sonnet-5.5';
  const signal = () => new AbortController().signal;

  it('a new chat starts at zero, and a fake turn adds 120 + 48 for its reply', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: MODEL });
    expect(chat.usage).toEqual(ZERO);
    await collect(api.sendMessage(chat.id, { text: 'hi', attachmentIds: [], model: MODEL }, signal()));
    expect((await api.getChat(chat.id)).usage).toEqual({
      contextTokens: 168,
      promptTokens: 120,
      completionTokens: 48,
      costUsd: null,
      requests: 1,
    });
  });

  it('a tool turn counts both of its requests, and the final chat_updated carries the totals', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const [project] = await api.listProjects();
    const chat = await api.createChat({ projectId: project?.id ?? null, model: MODEL });
    const events = await collect(
      api.sendMessage(chat.id, { text: 'Explain', attachmentIds: [], model: MODEL }, signal()),
    );
    const expected = { contextTokens: 168, promptTokens: 240, completionTokens: 96, costUsd: null, requests: 2 };
    const last = events.filter((e) => e.type === 'chat_updated').at(-1);
    expect(last?.type === 'chat_updated' && last.chat.usage).toEqual(expected);
    expect((await api.getChat(chat.id)).usage).toEqual(expected);
  });

  it('the totals survive a retry: the discarded reply still counts, and the context follows the new one', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: MODEL });
    await collect(api.sendMessage(chat.id, { text: 'hi', attachmentIds: [], model: MODEL }, signal()));
    const events = await collect(api.retry(chat.id, { model: MODEL }, signal()));

    const saved = await api.getChat(chat.id);
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const expected = { contextTokens: 168, promptTokens: 240, completionTokens: 96, costUsd: null, requests: 2 };
    expect(saved.usage).toEqual(expected);
    const last = events.filter((e) => e.type === 'chat_updated').at(-1);
    expect(last?.type === 'chat_updated' && last.chat.usage).toEqual(expected);
  });

  it('seeded chats carry their sample usage; a chat with no replies starts at zero', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chats = await api.listChats();
    expect(chats.find((c) => c.title === 'Streaming replies over SSE')?.usage).toEqual({
      contextTokens: 860_000,
      promptTokens: 858_000,
      completionTokens: 2_000,
      costUsd: 0.0031,
      requests: 1,
    });
    expect(chats.find((c) => c.title === 'Theme toggle transition')?.usage).toEqual({
      contextTokens: 12_400,
      promptTokens: 12_000,
      completionTokens: 400,
      costUsd: 0.00006,
      requests: 1,
    });
    expect(chats.find((c) => c.title === 'Settings: what goes in v1')?.usage).toEqual(ZERO);
  });
});
