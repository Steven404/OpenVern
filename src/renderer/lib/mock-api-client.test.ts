import {
  APPLY_PROJECT_CHANGED,
  CHAT_PROJECT_CHANGED,
  EDIT_MODE_CHANGED,
  PROJECT_NOT_IN_GIT,
  PROPOSALS_OTHER_PROJECT,
  RETRY_OTHER_PROJECT,
} from '@shared/api';
import { LIMITS, NEW_CHAT_TITLE } from '@shared/constants';
import type { AgentEvent } from '@shared/events';
import { describe, expect, it } from 'vitest';
import { ApiError, isChatProjectChanged, isEditModeChanged, isProjectNotInGit } from './api-client';
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

  it('archives a project chat and keeps the flag on project → project and project → loose moves', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const [first, second] = await api.listProjects();
    if (!first || !second) throw new Error('seed missing');
    const chat = await api.createChat({ projectId: first.id, model: 'm' });
    expect(chat.archived).toBe(false);

    const archived = await api.updateChat(chat.id, { archived: true });
    expect(archived).toMatchObject({ projectId: first.id, archived: true, updatedAt: chat.updatedAt });
    expect((await api.getChat(chat.id)).archived).toBe(true);
    expect((await api.listChats()).find((c) => c.id === chat.id)?.archived).toBe(true);

    const toSecond = await api.updateChat(chat.id, { projectId: second.id });
    expect(toSecond).toMatchObject({ projectId: second.id, archived: true });
    expect(await api.getChat(chat.id)).toMatchObject({ projectId: second.id, archived: true });

    const loose = await api.updateChat(chat.id, { projectId: null });
    expect(loose).toMatchObject({ projectId: null, archived: true });
    expect((await api.getChat(chat.id)).archived).toBe(true);

    const restored = await api.updateChat(chat.id, { archived: false });
    expect(restored).toMatchObject({ projectId: null, archived: false });
    expect((await api.getChat(chat.id)).archived).toBe(false);
  });

  it('a project chat: archiving during a run conflicts, a plain move is allowed and keeps the flag', async () => {
    const api = new MockApiClient({ delayMs: 0, seed: false });
    const first = await api.createProject({ rootPath: '/tmp/first', name: 'First' });
    const second = await api.createProject({ rootPath: '/tmp/second', name: 'Second' });
    const chat = await api.createChat({ projectId: first.id, model: 'anthropic/claude-sonnet-5.5' });
    const run = api
      .sendMessage(chat.id, { text: 'go', attachmentIds: [], model: chat.model }, new AbortController().signal)
      [Symbol.asyncIterator]();
    await run.next(); // the run is registered once the first event is out

    const err = await api.updateChat(chat.id, { archived: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      info: {
        code: 'conflict',
        message: 'Wait for the response to finish before archiving or unarchiving this chat.',
      },
    });
    expect(await api.getChat(chat.id)).toMatchObject({ projectId: first.id, archived: false });

    const moved = await api.updateChat(chat.id, { projectId: second.id });
    expect(moved).toMatchObject({ projectId: second.id, archived: false });
    expect((await api.getChat(chat.id)).projectId).toBe(second.id);

    await run.return?.(undefined);
    expect((await api.updateChat(chat.id, { archived: true })).archived).toBe(true);
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
    it('lists sorted project folders one at a time, searches, and reads a file', async () => {
      const api = new MockApiClient({ delayMs: 0 });
      const [project] = await api.listProjects();
      const tree = await api.listProjectFiles(project?.id ?? '');
      expect(tree.truncated).toBe(false);
      expect(tree.path).toBe('');
      expect(tree.entries[0]).toEqual({ path: 'build', type: 'dir' });
      expect(tree.entries.at(-1)?.type).toBe('file');
      expect(tree.entries.every((e) => !e.path.includes('/'))).toBe(true);
      const src = await api.listProjectFiles(project?.id ?? '', 'src');
      expect(src.path).toBe('src');
      expect(src.entries.length).toBeGreaterThan(0);
      expect(src.entries.every((e) => e.path.startsWith('src/') && !e.path.slice(4).includes('/'))).toBe(true);
      await expect(api.listProjectFiles(project?.id ?? '', 'nope')).rejects.toMatchObject({ status: 404 });
      // A file passed as a folder is refused like the server does (400, not 404), for project and home.
      for (const list of [
        () => api.listProjectFiles(project?.id ?? '', 'README.md'),
        () => api.listHomeFiles('README.md'),
      ])
        await expect(list()).rejects.toMatchObject({ status: 400, info: { code: 'invalid_request' } });
      const hits = await api.searchProjectFiles(project?.id ?? '', 'READ-FILE');
      expect(hits.entries.length).toBeGreaterThan(0);
      expect(hits.entries.every((e) => e.type === 'file' && e.path.toLowerCase().includes('read-file'))).toBe(true);
      await expect(api.searchProjectFiles(project?.id ?? '', ' ')).rejects.toMatchObject({ status: 400 });
      const long = 'x'.repeat(LIMITS.fileSearchMaxQueryLength + 1);
      for (const search of [() => api.searchProjectFiles(project?.id ?? '', long), () => api.searchHomeFiles(long)])
        await expect(search()).rejects.toMatchObject({ status: 400, info: { code: 'invalid_request' } });
      await expect(api.searchHomeFiles('')).rejects.toMatchObject({ status: 400 });
      // The longest accepted query (padding is trimmed first, as on the server) still searches.
      const longest = ` ${'x'.repeat(LIMITS.fileSearchMaxQueryLength)} `;
      expect(await api.searchProjectFiles(project?.id ?? '', longest)).toEqual({ entries: [], truncated: false });
      expect((await api.listHomeFiles('src')).root).toBe('/home/you');
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
      expect(await api.getChatChanges(chat.id)).toEqual({ pending: null, applied: [], diskSeq: 0 });

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

    it('refuses moving a chat with pending edits, alone or with archived; archiving alone still works', async () => {
      const api = new MockApiClient({ delayMs: 0 });
      const [project, other] = await api.listProjects();
      if (!project || !other) throw new Error('seed missing');
      const chat = await api.createChat({ projectId: project.id, model: 'anthropic/claude-sonnet-5.5' });
      await collect(
        api.sendMessage(
          chat.id,
          { text: '[mock:edit]', attachmentIds: [], model: chat.model },
          new AbortController().signal,
        ),
      );
      const before = await api.getChatChanges(chat.id);
      expect(before.pending).not.toBeNull();

      for (const patch of [{ projectId: other.id }, { projectId: null }, { projectId: other.id, archived: true }]) {
        await expect(api.updateChat(chat.id, patch)).rejects.toMatchObject({
          status: 409,
          info: { code: 'conflict', message: 'Apply or discard the proposed edits first.' },
        });
        expect(await api.getChat(chat.id)).toMatchObject({ projectId: project.id, archived: false });
      }
      expect(await api.getChatChanges(chat.id)).toEqual(before);

      // Same project (not a move), title and archive-only patches are allowed.
      expect(await api.updateChat(chat.id, { projectId: project.id, title: 'Kept' })).toMatchObject({
        projectId: project.id,
        title: 'Kept',
      });
      expect(await api.updateChat(chat.id, { archived: true })).toMatchObject({
        projectId: project.id,
        archived: true,
      });

      await api.discardChatChanges(chat.id);
      expect(await api.updateChat(chat.id, { projectId: other.id })).toMatchObject({
        projectId: other.id,
        archived: true,
      });
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
      expect(await api.discardChatChanges(chat.id)).toEqual({ pending: null, applied: [], diskSeq: 0 });
    });

    it('applies proposals only in the project they were made for, and only when it is the shown one', async () => {
      const api = new MockApiClient({ delayMs: 0 });
      const [project, other] = await api.listProjects();
      if (!project || !other) throw new Error('seed missing');
      const chat = await api.createChat({ projectId: project.id, model: 'anthropic/claude-sonnet-5.5' });
      // The turn starts in `project`; the chat moves to `other` before it stages anything.
      const iter = api
        .sendMessage(
          chat.id,
          { text: '[mock:edit]', attachmentIds: [], model: chat.model },
          new AbortController().signal,
        )
        [Symbol.asyncIterator]();
      await iter.next();
      expect((await api.getChatChanges(chat.id)).pending).toBeNull();
      await api.updateChat(chat.id, { projectId: other.id });
      while (!(await iter.next()).done) {
        // drain: stages the proposals for `project`
      }
      const { pending } = await api.getChatChanges(chat.id);
      if (!pending) throw new Error('Expected pending proposals');
      const body = { revision: pending.revision, decisions: {} };
      for (const expectedProjectId of [other.id, undefined]) {
        await expect(
          api.applyChatChanges(chat.id, { ...body, ...(expectedProjectId ? { expectedProjectId } : {}) }),
        ).rejects.toMatchObject({ status: 409, info: { code: 'conflict', message: PROPOSALS_OTHER_PROJECT } });
      }
      expect((await api.getChatChanges(chat.id)).pending).toEqual(pending);
      // A turn in `other` can't add to them.
      const events = await collect(
        api.sendMessage(
          chat.id,
          { text: '[mock:edit]', attachmentIds: [], model: chat.model },
          new AbortController().signal,
        ),
      );
      expect(events.some((e) => e.type === 'changes_updated')).toBe(false);
      expect((await api.getChatChanges(chat.id)).pending).toEqual(pending);
      // Discard always works; then a set made in `other` applies there, unless the shown project is stale.
      expect((await api.discardChatChanges(chat.id)).pending).toBeNull();
      await collect(
        api.sendMessage(
          chat.id,
          { text: '[mock:edit]', attachmentIds: [], model: chat.model },
          new AbortController().signal,
        ),
      );
      const fresh = (await api.getChatChanges(chat.id)).pending;
      if (!fresh) throw new Error('Expected pending proposals');
      await expect(
        api.applyChatChanges(chat.id, { revision: fresh.revision, decisions: {}, expectedProjectId: project.id }),
      ).rejects.toMatchObject({ status: 409, info: { code: 'conflict', message: APPLY_PROJECT_CHANGED } });
      const res = await api.applyChatChanges(chat.id, {
        revision: fresh.revision,
        decisions: {},
        expectedProjectId: other.id,
      });
      expect(res.changes.pending).toBeNull();
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

describe('MockApiClient effort (F3)', () => {
  const MODEL = 'anthropic/claude-sonnet-5.5';
  const signal = () => new AbortController().signal;

  it('a sent effort is stored on the chat; a send without one keeps the stored effort', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: MODEL });
    expect(chat.effort).toBeNull();
    await collect(api.sendMessage(chat.id, { text: 'hi', attachmentIds: [], model: MODEL, effort: 'high' }, signal()));
    expect((await api.getChat(chat.id)).effort).toBe('high');
    await collect(api.sendMessage(chat.id, { text: 'again', attachmentIds: [], model: MODEL }, signal()));
    expect((await api.getChat(chat.id)).effort).toBe('high');
  });

  it('null (Default) is stored as Default', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: MODEL });
    await collect(api.sendMessage(chat.id, { text: 'hi', attachmentIds: [], model: MODEL, effort: 'low' }, signal()));
    await collect(api.sendMessage(chat.id, { text: 'again', attachmentIds: [], model: MODEL, effort: null }, signal()));
    expect((await api.getChat(chat.id)).effort).toBeNull();
  });

  it('retry without an effort keeps the stored one; with one, it replaces it', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: MODEL });
    await collect(api.sendMessage(chat.id, { text: 'hi', attachmentIds: [], model: MODEL, effort: 'low' }, signal()));
    await collect(api.retry(chat.id, { model: MODEL }, signal()));
    expect((await api.getChat(chat.id)).effort).toBe('low');
    await collect(api.retry(chat.id, { model: MODEL, effort: 'max' }, signal()));
    expect((await api.getChat(chat.id)).effort).toBe('max');
  });

  it('the final chat_updated carries the effort', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: MODEL });
    const events = await collect(
      api.sendMessage(chat.id, { text: 'hi', attachmentIds: [], model: MODEL, effort: 'medium' }, signal()),
    );
    const last = events.filter((e) => e.type === 'chat_updated').at(-1);
    expect(last?.type === 'chat_updated' && last.chat.effort).toBe('medium');
  });

  it('lastEffort round-trips through updateSettings and getSettings, and a lastModel patch keeps it', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    expect((await api.getSettings()).lastEffort).toBeNull();
    expect((await api.updateSettings({ lastEffort: 'high' })).lastEffort).toBe('high');
    expect((await api.getSettings()).lastEffort).toBe('high');
    expect((await api.updateSettings({ lastModel: MODEL })).lastEffort).toBe('high');
    expect((await api.updateSettings({ lastEffort: null })).lastEffort).toBeNull();
    expect((await api.getSettings()).lastEffort).toBeNull();
  });
});

describe('MockApiClient Auto mode', () => {
  const MODEL = 'anthropic/claude-sonnet-5.5';
  const sig = () => new AbortController().signal;

  async function seeded() {
    const api = new MockApiClient({ delayMs: 0 });
    const projects = await api.listProjects();
    const git = projects.find((p) => p.inGitRepo);
    const noGit = projects.find((p) => !p.inGitRepo);
    if (!git || !noGit) throw new Error('seed needs a Git and a no-Git project');
    const autoChat = (await api.listChats()).find((c) => c.title === 'Streaming replies over SSE');
    if (!autoChat) throw new Error('seed lost the Auto chat');
    return { api, git, noGit, autoChat };
  }

  /** A turn sent with the chat's mode, as the UI would show it. */
  const editTurn = async (api: MockApiClient, chatId: string, text = 'do it [mock:edit]') => {
    const expectedEditMode = (await api.getChat(chatId)).editMode;
    return collect(api.sendMessage(chatId, { text, attachmentIds: [], model: MODEL, expectedEditMode }, sig()));
  };

  async function autoChatIn(api: MockApiClient, projectId: string) {
    const chat = await api.createChat({ projectId, model: MODEL, editMode: 'auto' });
    return chat;
  }

  it('persists editMode on createChat (default review) and on updateChat, also while a run is active', async () => {
    const { api, git } = await seeded();
    const plain = await api.createChat({ projectId: git.id, model: MODEL });
    expect(plain.editMode).toBe('review');
    const auto = await api.createChat({ projectId: git.id, model: MODEL, editMode: 'auto' });
    expect(auto.editMode).toBe('auto');
    expect((await api.getChat(auto.id)).editMode).toBe('auto');
    expect((await api.listChats()).find((c) => c.id === auto.id)?.editMode).toBe('auto');

    expect((await api.updateChat(plain.id, { editMode: 'auto' })).editMode).toBe('auto');
    expect((await api.getChat(plain.id)).editMode).toBe('auto');

    const iter = api
      .sendMessage(plain.id, { text: 'hi', attachmentIds: [], model: MODEL, expectedEditMode: 'auto' }, sig())
      [Symbol.asyncIterator]();
    await iter.next();
    await expect(api.updateChat(plain.id, { editMode: 'review' })).resolves.toMatchObject({ editMode: 'review' });
    while (!(await iter.next()).done);
  });

  it('seeds exactly one project outside Git', async () => {
    const { api } = await seeded();
    const projects = await api.listProjects();
    expect(projects.filter((p) => !p.inGitRepo).map((p) => p.name)).toEqual(['Portfolio site']);
  });

  it('seeds "Streaming replies over SSE" in Auto with one undoable auto batch', async () => {
    const { api, autoChat } = await seeded();
    expect((await api.getChat(autoChat.id)).editMode).toBe('auto');
    const changes = await api.getChatChanges(autoChat.id);
    expect(changes.pending).toBeNull();
    expect(changes.applied).toHaveLength(1);
    const batch = changes.applied[0];
    expect(batch).toMatchObject({ source: 'auto', undoable: true, conflicts: [], rejectedHunks: 0, skippedHunks: 0 });
    expect(batch?.undo).toBeUndefined();
    expect(batch?.written.map((f) => f.path)).toEqual(['src/server/app.ts', 'src/server/sse.ts']);
    expect(changes.diskSeq).toBeGreaterThan(0);
    // The project id the mock keeps for its own checks is never sent.
    expect(batch).not.toHaveProperty('projectId');
    const chat = await api.getChat(autoChat.id);
    expect(chat.messages.some((m) => m.id === batch?.turnId && m.role === 'user')).toBe(true);
  });

  it('undoChatBatch restores the batch, marks it undone by the user, and bumps diskSeq', async () => {
    const { api, autoChat } = await seeded();
    const before = await api.getChatChanges(autoChat.id);
    const batch = before.applied[0];
    const res = await api.undoChatBatch(autoChat.id, batch?.id ?? '');
    expect(res.batch.undoable).toBe(false);
    expect(res.batch.undo).toMatchObject({
      by: 'user',
      restored: ['src/server/app.ts', 'src/server/sse.ts'],
      skipped: [],
    });
    expect(res.changes.applied[0]?.undo?.by).toBe('user');
    expect(res.changes.applied[0]?.undoable).toBe(false);
    expect(res.changes.diskSeq).toBe(before.diskSeq + 1);
    expect(await api.getChatChanges(autoChat.id)).toEqual(res.changes);
  });

  it('undoChatBatch refuses an undone batch, an unknown id and a review batch', async () => {
    const { api, git, autoChat } = await seeded();
    const batch = (await api.getChatChanges(autoChat.id)).applied[0];
    await api.undoChatBatch(autoChat.id, batch?.id ?? '');
    await expect(api.undoChatBatch(autoChat.id, batch?.id ?? '')).rejects.toMatchObject({ status: 409 });
    await expect(api.undoChatBatch(autoChat.id, 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(api.undoChatBatch('no-chat', 'nope')).rejects.toMatchObject({ status: 404 });

    const chat = await api.createChat({ projectId: git.id, model: MODEL });
    await editTurn(api, chat.id);
    const { pending } = await api.getChatChanges(chat.id);
    const applied = await api.applyChatChanges(chat.id, {
      revision: pending?.revision ?? 0,
      decisions: Object.fromEntries(
        (pending?.files ?? []).map((f) => [
          f.path,
          Object.fromEntries(f.hunks.map((h) => [h.id, 'accepted' as const])),
        ]),
      ),
    });
    expect(applied.batch).toMatchObject({ source: 'review', undoable: false });
    await expect(api.undoChatBatch(chat.id, applied.batch.id)).rejects.toMatchObject({ status: 409 });
  });

  it('undoChatBatch is refused with a 409 while the chat runs', async () => {
    const { api, autoChat } = await seeded();
    const batch = (await api.getChatChanges(autoChat.id)).applied[0];
    const iter = api
      .sendMessage(autoChat.id, { text: 'continue', attachmentIds: [], model: MODEL, expectedEditMode: 'auto' }, sig())
      [Symbol.asyncIterator]();
    await iter.next();
    const err = await api.undoChatBatch(autoChat.id, batch?.id ?? '').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, info: { code: 'conflict' } });
    while (!(await iter.next()).done);
    await expect(api.undoChatBatch(autoChat.id, batch?.id ?? '')).resolves.toBeDefined();
  });

  it('an undo is refused once the chat moved to another project', async () => {
    const { api, git, autoChat } = await seeded();
    const other = (await api.listProjects()).find((p) => p.inGitRepo && p.id !== autoChat.projectId) ?? git;
    await api.updateChat(autoChat.id, { projectId: other.id, expectedEditMode: 'auto' });
    const batch = (await api.getChatChanges(autoChat.id)).applied[0];
    expect(batch?.undoable).toBe(false);
    await expect(api.undoChatBatch(autoChat.id, batch?.id ?? '')).rejects.toMatchObject({ status: 409 });
  });

  it('an Auto turn writes straight to one auto batch: no pending proposal, auto_batch_updated per write', async () => {
    const { api, git } = await seeded();
    const chat = await autoChatIn(api, git.id);
    const events = await editTurn(api, chat.id);
    expect(events.filter((e) => e.type === 'changes_updated')).toHaveLength(0);
    const updates = events.filter((e) => e.type === 'auto_batch_updated');
    expect(updates).toHaveLength(3);
    for (const [i, e] of events.entries()) {
      if (e.type === 'auto_batch_updated') expect(events[i - 1]?.type).toBe('tool_result');
    }
    const changes = await api.getChatChanges(chat.id);
    expect(changes.pending).toBeNull();
    expect(changes.applied).toHaveLength(1);
    expect(changes.applied[0]).toMatchObject({ source: 'auto', undoable: true });
    expect(changes.applied[0]?.written.map((f) => f.path)).toEqual([
      'src/core/tools/index.ts',
      'src/core/tools/write-file.ts',
      'src/shared/constants.ts',
    ]);
    expect(changes.diskSeq).toBe(3);
    const stored = await api.getChat(chat.id);
    const tools = stored.messages.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(3);
    expect(tools.every((m) => m.role === 'tool' && m.ok && m.output.includes('Written to disk'))).toBe(true);
  });

  it('a Review turn still stages a proposal and writes nothing', async () => {
    const { api, git } = await seeded();
    const chat = await api.createChat({ projectId: git.id, model: MODEL });
    const events = await editTurn(api, chat.id);
    expect(events.filter((e) => e.type === 'auto_batch_updated')).toHaveLength(0);
    const changes = await api.getChatChanges(chat.id);
    expect(changes.pending?.files).toHaveLength(3);
    expect(changes.applied).toEqual([]);
    expect(changes.diskSeq).toBe(0);
  });

  it('refuses a send, retry or PATCH whose expectedEditMode differs, like the server, and changes nothing', async () => {
    const { api, git, noGit } = await seeded();
    const chat = await autoChatIn(api, git.id);
    await editTurn(api, chat.id);
    const before = await api.getChat(chat.id);
    const changes = await api.getChatChanges(chat.id);
    const refused = async (p: Promise<unknown>) => {
      const err = await p.catch((e: unknown) => e);
      expect(isEditModeChanged(err)).toBe(true);
      expect(err).toMatchObject({ status: 409, info: { code: 'conflict', message: EDIT_MODE_CHANGED } });
    };
    await refused(
      collect(
        api.sendMessage(
          chat.id,
          { text: 'x [mock:edit]', attachmentIds: [], model: MODEL, expectedEditMode: 'review' },
          sig(),
        ),
      ),
    );
    await refused(collect(api.retry(chat.id, { model: MODEL, expectedEditMode: 'review' }, sig())));
    await refused(api.updateChat(chat.id, { projectId: noGit.id, expectedEditMode: 'review' }));
    await refused(api.updateChat(chat.id, { editMode: 'review', expectedEditMode: 'review' }));
    expect(await api.getChat(chat.id)).toEqual(before);
    expect(await api.getChatChanges(chat.id)).toEqual(changes);
    // A match goes through; a mode-only PATCH that names no mode is unchecked.
    const ran = await collect(api.retry(chat.id, { model: MODEL, expectedEditMode: 'auto' }, sig()));
    expect(ran.at(-1)).toEqual({ type: 'done' });
    await expect(
      api.updateChat(chat.id, { projectId: noGit.id, expectedEditMode: 'auto', expectedInGitRepo: false }),
    ).resolves.toMatchObject({ projectId: noGit.id });
    await expect(api.updateChat(chat.id, { editMode: 'review' })).resolves.toMatchObject({ editMode: 'review' });
  });

  it('a send, retry or move that names no mode expects Review, like the server', async () => {
    const { api, git, noGit } = await seeded();
    const chat = await autoChatIn(api, git.id);
    await editTurn(api, chat.id);
    const before = await api.getChat(chat.id);
    const changes = await api.getChatChanges(chat.id);
    for (const p of [
      collect(api.sendMessage(chat.id, { text: 'x [mock:edit]', attachmentIds: [], model: MODEL }, sig())),
      collect(api.retry(chat.id, { model: MODEL }, sig())),
      api.updateChat(chat.id, { projectId: noGit.id }),
    ]) {
      expect(isEditModeChanged(await p.catch((e: unknown) => e))).toBe(true);
    }
    expect(await api.getChat(chat.id)).toEqual(before);
    expect(await api.getChatChanges(chat.id)).toEqual(changes);
    // In a Review chat the same calls go through.
    const review = await api.createChat({ projectId: git.id, model: MODEL });
    await collect(api.sendMessage(review.id, { text: 'hi', attachmentIds: [], model: MODEL }, sig()));
    await collect(api.retry(review.id, { model: MODEL }, sig()));
    await expect(api.updateChat(review.id, { projectId: noGit.id })).resolves.toMatchObject({ projectId: noGit.id });
  });

  it('turning Auto on with an expectedProjectId the chat has left is refused, like the server', async () => {
    const { api, git, noGit } = await seeded();
    const chat = await api.createChat({ projectId: git.id, model: MODEL });
    await api.updateChat(chat.id, { projectId: noGit.id, expectedEditMode: 'review' });
    const err = await api.updateChat(chat.id, { editMode: 'auto', expectedProjectId: git.id }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, info: { code: 'conflict', message: CHAT_PROJECT_CHANGED } });
    expect(await api.getChat(chat.id)).toMatchObject({ projectId: noGit.id, editMode: 'review' });
    await expect(
      api.updateChat(chat.id, { editMode: 'auto', expectedProjectId: noGit.id, expectedInGitRepo: false }),
    ).resolves.toMatchObject({ editMode: 'auto' });
  });

  it('a send or retry naming a project the chat has left is refused, like the server, and changes nothing', async () => {
    const { api, git, noGit } = await seeded();
    const chat = await autoChatIn(api, git.id);
    await editTurn(api, chat.id);
    // Another window: to "No project", then into a project this sender never saw.
    await api.updateChat(chat.id, { projectId: null, expectedEditMode: 'auto' });
    await api.updateChat(chat.id, { projectId: noGit.id, expectedEditMode: 'auto', expectedInGitRepo: false });
    const before = await api.getChat(chat.id);
    const changes = await api.getChatChanges(chat.id);
    for (const shown of [null, git.id]) {
      for (const p of [
        collect(
          api.sendMessage(
            chat.id,
            {
              text: 'x [mock:edit]',
              attachmentIds: [],
              model: MODEL,
              expectedEditMode: 'auto',
              expectedProjectId: shown,
            },
            sig(),
          ),
        ),
        collect(api.retry(chat.id, { model: MODEL, expectedEditMode: 'auto', expectedProjectId: shown }, sig())),
      ]) {
        const err = await p.catch((e: unknown) => e);
        expect(isChatProjectChanged(err)).toBe(true);
        expect(err).toMatchObject({ status: 409, info: { code: 'conflict', message: CHAT_PROJECT_CHANGED } });
      }
    }
    expect(await api.getChat(chat.id)).toEqual(before);
    expect(await api.getChatChanges(chat.id)).toEqual(changes);
    const ran = await collect(
      api.retry(chat.id, { model: MODEL, expectedEditMode: 'auto', expectedProjectId: noGit.id }, sig()),
    );
    expect(ran.at(-1)).toEqual({ type: 'done' });
  });

  it('Auto in a folder that left Git is refused unless the UI showed it outside Git, like the server', async () => {
    const { api, git } = await seeded();
    const review = await api.createChat({ projectId: git.id, model: MODEL });
    const other = (await api.listProjects()).find((p) => p.inGitRepo && p.id !== git.id);
    if (!other) throw new Error('seed needs two Git projects');
    const moving = await autoChatIn(api, other.id);
    api.setProjectInGitRepo(git.id, false);
    const chats = await api.listChats();
    for (const shown of [{ expectedInGitRepo: true }, {}]) {
      for (const p of [
        api.updateChat(review.id, { editMode: 'auto', expectedProjectId: git.id, ...shown }),
        api.createChat({ projectId: git.id, model: MODEL, editMode: 'auto', ...shown }),
        api.updateChat(moving.id, { projectId: git.id, expectedEditMode: 'auto', ...shown }),
      ]) {
        const err = await p.catch((e: unknown) => e);
        expect(isProjectNotInGit(err)).toBe(true);
        expect(err).toMatchObject({ status: 409, info: { code: 'conflict', message: PROJECT_NOT_IN_GIT } });
      }
    }
    expect(await api.listChats()).toEqual(chats);
    expect((await api.listProjects()).find((p) => p.id === git.id)?.inGitRepo).toBe(false);
    // Shown outside Git (the warning was decided): goes through. Review never asks.
    await expect(
      api.updateChat(moving.id, { projectId: git.id, editMode: 'review', expectedEditMode: 'auto' }),
    ).resolves.toMatchObject({ projectId: git.id, editMode: 'review' });
    await expect(
      api.updateChat(review.id, { editMode: 'auto', expectedProjectId: git.id, expectedInGitRepo: false }),
    ).resolves.toMatchObject({ editMode: 'auto' });
  });

  it('the mode a turn starts with holds for the whole turn, a change applies from the next one', async () => {
    const { api, git } = await seeded();
    const chat = await api.createChat({ projectId: git.id, model: MODEL });
    const iter = api
      .sendMessage(chat.id, { text: 'x [mock:edit]', attachmentIds: [], model: MODEL }, sig())
      [Symbol.asyncIterator]();
    await iter.next();
    await api.updateChat(chat.id, { editMode: 'auto' });
    while (!(await iter.next()).done);
    expect((await api.getChatChanges(chat.id)).pending?.files).toHaveLength(3);
    expect((await api.getChatChanges(chat.id)).applied).toEqual([]);
  });

  it('an Auto write onto a path with a pending proposal is refused, and no batch appears', async () => {
    const { api, git } = await seeded();
    const chat = await api.createChat({ projectId: git.id, model: MODEL });
    await editTurn(api, chat.id);
    await api.updateChat(chat.id, { editMode: 'auto' });
    const events = await editTurn(api, chat.id, 'again [mock:edit]');
    expect(events.filter((e) => e.type === 'auto_batch_updated')).toHaveLength(0);
    const tools = (await api.getChat(chat.id)).messages.filter((m) => m.role === 'tool').slice(-3);
    expect(tools.every((m) => m.role === 'tool' && !m.ok && m.output.startsWith('Not written:'))).toBe(true);
    const changes = await api.getChatChanges(chat.id);
    expect(changes.applied).toEqual([]);
    expect(changes.pending?.files).toHaveLength(3);
  });

  it('a retry first undoes the previous attempt (by "retry") and emits auto_batch_updated before anything else', async () => {
    const { api, git } = await seeded();
    const chat = await autoChatIn(api, git.id);
    await editTurn(api, chat.id);
    const first = (await api.getChatChanges(chat.id)).applied[0];
    const seqBefore = (await api.getChatChanges(chat.id)).diskSeq;
    const events = await collect(api.retry(chat.id, { model: MODEL, expectedEditMode: 'auto' }, sig()));
    expect(events[0]).toMatchObject({ type: 'auto_batch_updated', batchId: first?.id });
    const changes = await api.getChatChanges(chat.id);
    const undone = changes.applied.find((b) => b.id === first?.id);
    expect(undone).toMatchObject({ undoable: false });
    expect(undone?.undo).toMatchObject({ by: 'retry', skipped: [] });
    expect(undone?.undo?.restored).toHaveLength(3);
    expect(changes.diskSeq).toBeGreaterThan(seqBefore);
    // The next retry has nothing left to undo.
    const again = await collect(api.retry(chat.id, { model: MODEL, expectedEditMode: 'auto' }, sig()));
    expect(again.some((e) => e.type === 'auto_batch_updated')).toBe(false);
  });

  it('keeps undo for the newest autoUndoTurns auto batches only', async () => {
    const { api, git } = await seeded();
    const chat = await autoChatIn(api, git.id);
    for (let i = 0; i < LIMITS.autoUndoTurns + 1; i++) await editTurn(api, chat.id, `t${i} [mock:edit]`);
    const { applied } = await api.getChatChanges(chat.id);
    expect(applied).toHaveLength(LIMITS.autoUndoTurns + 1);
    expect(applied[0]?.undoable).toBe(false);
    expect(applied.slice(1).every((b) => b.undoable)).toBe(true);
    await expect(api.undoChatBatch(chat.id, applied[0]?.id ?? '')).rejects.toMatchObject({ status: 409 });
    await expect(api.undoChatBatch(chat.id, applied[1]?.id ?? '')).resolves.toBeDefined();
  });

  it('keeps the newest 100 batches while diskSeq keeps counting past them', async () => {
    const { api, git } = await seeded();
    const chat = await autoChatIn(api, git.id);
    for (let i = 0; i < 101; i++) await editTurn(api, chat.id, `t${i} [mock:edit]`);
    const { applied, diskSeq } = await api.getChatChanges(chat.id);
    expect(applied).toHaveLength(100);
    expect(diskSeq).toBe(101 * 3);
    // The Files refresh keys on this: the list length no longer moves, the counter does.
    await editTurn(api, chat.id, 'one more [mock:edit]');
    const after = await api.getChatChanges(chat.id);
    expect(after.applied).toHaveLength(100);
    expect(after.diskSeq).toBe(102 * 3);
  });

  it('deleting a chat drops its batches and counter', async () => {
    const { api, autoChat } = await seeded();
    await api.deleteChat(autoChat.id);
    await expect(api.getChatChanges(autoChat.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('MockApiClient: a project change resets Auto state, like the server', () => {
  const MODEL = 'anthropic/claude-sonnet-5.5';
  const sig = () => new AbortController().signal;

  async function twoGitProjects() {
    const api = new MockApiClient({ delayMs: 0 });
    const [a, b] = (await api.listProjects()).filter((p) => p.inGitRepo);
    if (!a || !b) throw new Error('seed needs two Git projects');
    const chat = await api.createChat({ projectId: a.id, model: MODEL, editMode: 'auto' });
    const move = (from: string, to: string) =>
      api.updateChat(chat.id, {
        projectId: to,
        expectedEditMode: 'auto',
        expectedProjectId: from,
        expectedInGitRepo: true,
      });
    const send = (text = 'do it [mock:edit]') =>
      api.sendMessage(chat.id, { text, attachmentIds: [], model: MODEL, expectedEditMode: 'auto' }, sig());
    const retry = (projectId: string) =>
      collect(api.retry(chat.id, { model: MODEL, expectedEditMode: 'auto', expectedProjectId: projectId }, sig()));
    return { api, a, b, chat, move, send, retry };
  }

  it('a move closes the open batch; the in-flight turn keeps writing into its pinned project, in a new batch', async () => {
    const { api, a, b, chat, move, send } = await twoGitProjects();
    let moved = false;
    for await (const e of send()) {
      if (e.type === 'auto_batch_updated' && !moved) {
        moved = true;
        await move(a.id, b.id);
      }
    }
    const inB = await api.getChatChanges(chat.id);
    expect(inB.applied.map((x) => x.written.length)).toEqual([1, 2]);
    expect(inB.applied.every((x) => !x.undoable)).toBe(true);
    await move(b.id, a.id);
    expect((await api.getChatChanges(chat.id)).applied.every((x) => x.undoable)).toBe(true);
  });

  it('a retry in another project is refused while the turn’s writes are undoable where they were written', async () => {
    const { api, a, b, chat, move, send, retry } = await twoGitProjects();
    await collect(send());
    await move(a.id, b.id);
    const before = (await api.getChat(chat.id)).messages;
    const events = await retry(b.id);
    expect(events).toEqual([
      { type: 'error', error: expect.objectContaining({ code: 'conflict', message: RETRY_OTHER_PROJECT }) },
      { type: 'done' },
    ]);
    expect((await api.getChat(chat.id)).messages).toEqual(before);
    expect((await api.getChatChanges(chat.id)).applied[0]).not.toHaveProperty('undo');
  });

  it('a retry undoes every batch of the turn in its own project, and none in a removed one (which never blocks it)', async () => {
    const { api, a, b, chat, move, send, retry } = await twoGitProjects();
    let moved = false;
    for await (const e of send()) {
      if (e.type === 'auto_batch_updated' && !moved) {
        moved = true;
        await move(a.id, b.id);
      }
    }
    await move(b.id, a.id);
    // Both batches of the turn are in A (one closed by the move): a retry in A undoes them all.
    const events = await retry(a.id);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const applied = (await api.getChatChanges(chat.id)).applied;
    expect(applied).toHaveLength(2);
    expect(applied.every((x) => x.undo?.by === 'retry')).toBe(true);

    // A later turn writes in A; the chat moves to B and A is removed: a retry in B undoes nothing of A.
    await collect(send('again [mock:edit]'));
    const latest = (await api.getChatChanges(chat.id)).applied.at(-1);
    await move(a.id, b.id);
    await api.deleteProject(a.id);
    const again = await retry(b.id);
    expect(again.some((e) => e.type === 'error' || e.type === 'auto_batch_updated')).toBe(false);
    expect((await api.getChatChanges(chat.id)).applied.find((x) => x.id === latest?.id)).not.toHaveProperty('undo');
  });

  it('a move to no project right after the user message keeps the pinned turn’s tools: it still writes in A', async () => {
    const { api, a, chat, send } = await twoGitProjects();
    const events: AgentEvent[] = [];
    for await (const e of send()) {
      events.push(e);
      if (e.type === 'user_message') {
        await api.updateChat(chat.id, { projectId: null, expectedEditMode: 'auto', expectedProjectId: a.id });
      }
    }
    expect((await api.getChat(chat.id)).projectId).toBeNull();
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(3);
    expect(events.some((e) => e.type === 'auto_batch_updated')).toBe(true);
    const applied = (await api.getChatChanges(chat.id)).applied;
    expect(applied.flatMap((x) => x.written.map((f) => f.path))).toHaveLength(3);
  });

  it('removing a project discards its chats’ pending proposals', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const [a] = (await api.listProjects()).filter((p) => p.inGitRepo);
    if (!a) throw new Error('seed needs a Git project');
    const chat = await api.createChat({ projectId: a.id, model: MODEL });
    await collect(api.sendMessage(chat.id, { text: 'x [mock:edit]', attachmentIds: [], model: MODEL }, sig()));
    expect((await api.getChatChanges(chat.id)).pending?.files).toHaveLength(3);
    await api.deleteProject(a.id);
    expect((await api.getChatChanges(chat.id)).pending).toBeNull();
    expect((await api.getChat(chat.id)).projectId).toBeNull();
  });
});
