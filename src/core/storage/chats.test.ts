import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NEW_CHAT_TITLE } from '@shared/constants';
import type { AssistantMessage, Message, Usage, UserMessage } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { createStorage } from './index';
import { dataPaths } from './paths';
import { cleanupTempDirs, MemorySecretStore, makeStorage, makeTempDir, recordingLogger } from './test-helpers';

cleanupTempDirs();

const user = (id: string, text = 'hi'): UserMessage => ({
  id,
  role: 'user',
  createdAt: new Date().toISOString(),
  text,
  attachments: [],
});
const assistant = (id: string): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: new Date().toISOString(),
  model: 'm',
  text: 'yo',
  toolCalls: [],
  status: 'complete',
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readIndex(dataDir: string): Promise<{ chats: { id: string }[] }> {
  return JSON.parse(await fs.readFile(dataPaths(dataDir).chatsIndex, 'utf8'));
}

describe('ChatsService', () => {
  it('creates an empty "New chat" and persists it in file + index', async () => {
    const { storage, dataDir } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm1' });
    expect(chat).toMatchObject({ title: NEW_CHAT_TITLE, projectId: null, model: 'm1', messages: [] });
    expect(chat.createdAt).toBe(chat.updatedAt);
    expect(await storage.chats.get(chat.id)).toEqual(chat);
    const onDisk = JSON.parse(await fs.readFile(dataPaths(dataDir).chatFile(chat.id), 'utf8'));
    expect(onDisk.version).toBe(1);
    expect((await readIndex(dataDir)).chats.map((c) => c.id)).toEqual([chat.id]);
  });

  it('create/update reject unknown project ids with not_found', async () => {
    const { storage } = await makeStorage();
    await expect(storage.chats.create({ projectId: 'nope', model: 'm' })).rejects.toMatchObject({ code: 'not_found' });
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await expect(storage.chats.update(chat.id, { projectId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await storage.chats.list()).toHaveLength(1);
  });

  it('get/update/remove/append on unknown or unsafe ids give not_found', async () => {
    const { storage } = await makeStorage();
    for (const id of ['missing', '../secrets', 'a/b', 'index']) {
      await expect(storage.chats.get(id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(storage.chats.update(id, { title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(storage.chats.remove(id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(storage.chats.appendMessage(id, user('u'))).rejects.toMatchObject({ code: 'not_found' });
      await expect(storage.chats.truncateAfterLastUser(id)).rejects.toMatchObject({ code: 'not_found' });
    }
  });

  it('the reserved id "index" never touches chats/index.json', async () => {
    const { storage, dataDir } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    const indexPath = dataPaths(dataDir).chatsIndex;
    const before = await fs.readFile(indexPath, 'utf8');
    await expect(storage.chats.get('index')).rejects.toMatchObject({ code: 'not_found' });
    await expect(storage.chats.update('index', { title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(storage.chats.appendMessage('index', user('u'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(storage.chats.truncateAfterLastUser('index')).rejects.toMatchObject({ code: 'not_found' });
    await expect(storage.chats.remove('index')).rejects.toMatchObject({ code: 'not_found' });
    expect(await fs.readFile(indexPath, 'utf8')).toBe(before);
    const names = await fs.readdir(path.dirname(indexPath));
    expect(names.some((n) => n.includes('.corrupt-'))).toBe(false);
    expect((await readIndex(dataDir)).chats.map((c) => c.id)).toEqual([chat.id]);
  });

  it('lists by updatedAt desc; appending bumps, renaming and moving do not', async () => {
    const { storage } = await makeStorage();
    const a = await storage.chats.create({ projectId: null, model: 'm' });
    await sleep(5);
    const b = await storage.chats.create({ projectId: null, model: 'm' });
    expect((await storage.chats.list()).map((c) => c.id)).toEqual([b.id, a.id]);

    await sleep(5);
    const renamed = await storage.chats.update(a.id, { title: 'Renamed' });
    expect(renamed.title).toBe('Renamed');
    expect(renamed.updatedAt).toBe(a.updatedAt);
    expect((await storage.chats.list()).map((c) => c.id)).toEqual([b.id, a.id]);

    await sleep(5);
    const summary = await storage.chats.appendMessage(a.id, user('u1'));
    expect(summary.updatedAt > a.updatedAt).toBe(true);
    expect((await storage.chats.list()).map((c) => c.id)).toEqual([a.id, b.id]);
    expect((await storage.chats.get(a.id)).messages.map((m) => m.id)).toEqual(['u1']);
  });

  it('update bumps updatedAt only when the model actually changes', async () => {
    const { storage } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm1' });
    await sleep(5);
    expect((await storage.chats.update(chat.id, { model: 'm1' })).updatedAt).toBe(chat.updatedAt);
    const changed = await storage.chats.update(chat.id, { model: 'm2' });
    expect(changed.model).toBe('m2');
    expect(changed.updatedAt > chat.updatedAt).toBe(true);
    expect((await storage.chats.list())[0]).toEqual(changed); // index in sync
  });

  it('moves a chat between projects and to loose', async () => {
    const { storage } = await makeStorage();
    const dir = await makeTempDir();
    const project = await storage.projects.create({ rootPath: dir });
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    expect((await storage.chats.update(chat.id, { projectId: project.id })).projectId).toBe(project.id);
    expect((await storage.projects.list())[0]?.chatCount).toBe(1);
    expect((await storage.chats.update(chat.id, { projectId: null })).projectId).toBeNull();
    expect((await storage.projects.list())[0]?.chatCount).toBe(0);
  });

  it('truncateAfterLastUser drops trailing assistant/tool messages', async () => {
    const { storage } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    const tool: Message = {
      id: 't1',
      role: 'tool',
      createdAt: new Date().toISOString(),
      toolCallId: 'c',
      name: 'read_file',
      ok: true,
      output: 'x',
      summary: 'x',
      durationMs: 1,
    };
    for (const m of [user('u1'), assistant('a1'), user('u2'), assistant('a2'), tool]) {
      await storage.chats.appendMessage(chat.id, m);
    }
    const cut = await storage.chats.truncateAfterLastUser(chat.id);
    expect(cut.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    expect((await storage.chats.get(chat.id)).messages).toHaveLength(3);
    // Idempotent, and a chat without messages is returned untouched.
    expect((await storage.chats.truncateAfterLastUser(chat.id)).messages).toHaveLength(3);
    const empty = await storage.chats.create({ projectId: null, model: 'm' });
    expect((await storage.chats.truncateAfterLastUser(empty.id)).messages).toEqual([]);
  });

  it('remove deletes the file and the index entry', async () => {
    const { storage, dataDir } = await makeStorage();
    const a = await storage.chats.create({ projectId: null, model: 'm' });
    const b = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.remove(a.id);
    await expect(storage.chats.get(a.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await storage.chats.list()).map((c) => c.id)).toEqual([b.id]);
    expect((await readIndex(dataDir)).chats.map((c) => c.id)).toEqual([b.id]);
    await expect(fs.stat(dataPaths(dataDir).chatFile(a.id))).rejects.toThrow();
  });

  it('keeps every message under concurrent appends', async () => {
    const { storage } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await Promise.all(Array.from({ length: 30 }, (_, i) => storage.chats.appendMessage(chat.id, user(`u${i}`))));
    const loaded = await storage.chats.get(chat.id);
    expect(loaded.messages.map((m) => m.id)).toEqual(Array.from({ length: 30 }, (_, i) => `u${i}`));
  });

  it('rebuilds a missing index by scanning chats/', async () => {
    const { storage, dataDir } = await makeStorage();
    const a = await storage.chats.create({ projectId: null, model: 'm' });
    await sleep(5);
    const b = await storage.chats.create({ projectId: null, model: 'm' });
    await sleep(5);
    await storage.chats.appendMessage(a.id, user('u1'));
    const expected = await storage.chats.list();

    await fs.rm(dataPaths(dataDir).chatsIndex);
    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore() });
    expect(await fresh.chats.list()).toEqual(expected);
    expect(expected.map((c) => c.id)).toEqual([a.id, b.id]);
    // And it was written back.
    expect((await readIndex(dataDir)).chats.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('rebuilds a corrupt index (backing it up) and skips corrupt chat files', async () => {
    const { storage, dataDir } = await makeStorage();
    const good = await storage.chats.create({ projectId: null, model: 'm' });
    const bad = await storage.chats.create({ projectId: null, model: 'm' });
    const paths = dataPaths(dataDir);
    await fs.writeFile(paths.chatsIndex, '{{{{');
    await fs.writeFile(paths.chatFile(bad.id), 'not json');

    const logger = recordingLogger();
    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore(), logger });
    expect((await fresh.chats.list()).map((c) => c.id)).toEqual([good.id]);
    const names = await fs.readdir(paths.chatsDir);
    expect(names.some((n) => n.startsWith('index.json.corrupt-'))).toBe(true);
    expect(names.some((n) => n.startsWith(`${bad.id}.json.corrupt-`))).toBe(true);
    expect(logger.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('after a rebuild, new chats keep the index in sync', async () => {
    const { storage, dataDir } = await makeStorage();
    const a = await storage.chats.create({ projectId: null, model: 'm' });
    await fs.rm(dataPaths(dataDir).chatsIndex);
    const b = await storage.chats.create({ projectId: null, model: 'm' });
    expect((await readIndex(dataDir)).chats.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('a chat file in a path-unsafe name is ignored by the rebuild', async () => {
    const { dataDir } = await makeStorage();
    const paths = dataPaths(dataDir);
    await fs.writeFile(path.join(paths.chatsDir, 'weird name.json'), '{}');
    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore() });
    expect(await fresh.chats.list()).toEqual([]);
  });

  it('the rebuild skips and logs an unreadable entry (a directory named x.json)', async () => {
    const { storage, dataDir } = await makeStorage();
    const good = await storage.chats.create({ projectId: null, model: 'm' });
    const paths = dataPaths(dataDir);
    await fs.mkdir(path.join(paths.chatsDir, 'x.json'));
    await fs.rm(paths.chatsIndex);

    const logger = recordingLogger();
    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore(), logger });
    expect((await fresh.chats.list()).map((c) => c.id)).toEqual([good.id]);
    expect(logger.messages.some((m) => m.includes('x.json'))).toBe(true);
  });
});

type RawTotals = { promptTokens: number; completionTokens: number; costUsd: number | null; requests: number };
type RawChat = {
  archived?: unknown;
  projectId: string | null;
  version?: number;
  messages?: { id: string }[];
  usageTotals?: RawTotals;
};

async function readRawChat(dataDir: string, id: string): Promise<RawChat> {
  return JSON.parse(await fs.readFile(dataPaths(dataDir).chatFile(id), 'utf8'));
}

async function readRawEntry(dataDir: string, id: string): Promise<RawChat> {
  const index = JSON.parse(await fs.readFile(dataPaths(dataDir).chatsIndex, 'utf8')) as {
    chats: (RawChat & { id: string })[];
  };
  const entry = index.chats.find((c) => c.id === id);
  if (!entry) throw new Error(`no index entry for ${id}`);
  return entry;
}

/** The raw chat file and the raw index entry must agree on `archived` and `projectId`. */
async function expectInSync(dataDir: string, id: string): Promise<void> {
  const file = await readRawChat(dataDir, id);
  const entry = await readRawEntry(dataDir, id);
  expect(typeof file.archived).toBe('boolean');
  expect(typeof entry.archived).toBe('boolean');
  expect(entry.archived).toBe(file.archived);
  expect(entry.projectId).toBe(file.projectId);
}

const ids = (chats: { id: string }[]) => chats.map((c) => c.id);
const NOT_ARCHIVABLE = 'Only chats without a project can be archived.';

const NOW = '2026-01-01T00:00:00.000Z';
const handChat = (id: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  id,
  projectId: null,
  title: `Chat ${id}`,
  model: 'm',
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    { id: `${id}-u`, role: 'user', createdAt: NOW, text: 'hi', attachments: [] },
    { id: `${id}-a`, role: 'assistant', createdAt: NOW, model: 'm', text: 'yo', toolCalls: [], status: 'complete' },
  ],
  ...extra,
});

async function names(dataDir: string): Promise<string[]> {
  return fs.readdir(dataPaths(dataDir).chatsDir);
}

describe('ChatsService archived flag', () => {
  it('create sets archived false in the return value, the file and the index', async () => {
    const { storage, dataDir } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    expect(chat.archived).toBe(false);
    expect((await readRawChat(dataDir, chat.id)).archived).toBe(false);
    expect((await readRawEntry(dataDir, chat.id)).archived).toBe(false);
    await expectInSync(dataDir, chat.id);
  });

  it('archives a loose chat without touching updatedAt, order or version, and restores it', async () => {
    const { storage, dataDir } = await makeStorage();
    const a = await storage.chats.create({ projectId: null, model: 'm' });
    await sleep(5);
    const b = await storage.chats.create({ projectId: null, model: 'm' });
    const before = ids(await storage.chats.list());
    expect(before).toEqual([b.id, a.id]);

    await sleep(5);
    const archived = await storage.chats.update(a.id, { archived: true });
    expect(archived.archived).toBe(true);
    expect(archived.updatedAt).toBe(a.updatedAt);
    expect((await storage.chats.get(a.id)).archived).toBe(true);
    await expectInSync(dataDir, a.id);
    await expectInSync(dataDir, b.id);
    expect((await readRawChat(dataDir, a.id)).archived).toBe(true);
    expect((await readRawEntry(dataDir, a.id)).archived).toBe(true);
    expect((await readRawChat(dataDir, a.id)).version).toBe(1);
    const listed = await storage.chats.list();
    expect(ids(listed)).toEqual(before);
    expect(listed.find((c) => c.id === a.id)).toMatchObject({ archived: true, updatedAt: a.updatedAt });
    expect(listed.find((c) => c.id === b.id)?.archived).toBe(false);

    await sleep(5);
    const restored = await storage.chats.update(a.id, { archived: false });
    expect(restored.archived).toBe(false);
    expect(restored.updatedAt).toBe(a.updatedAt);
    expect((await storage.chats.get(a.id)).archived).toBe(false);
    await expectInSync(dataDir, a.id);
    expect((await readRawChat(dataDir, a.id)).archived).toBe(false);
    expect(ids(await storage.chats.list())).toEqual(before);
  });

  it('refuses to archive a project chat and writes nothing', async () => {
    const { storage, dataDir } = await makeStorage();
    const project = await storage.projects.create({ rootPath: await makeTempDir() });
    const chat = await storage.chats.create({ projectId: project.id, model: 'm' });
    const paths = dataPaths(dataDir);
    const fileBefore = await fs.readFile(paths.chatFile(chat.id), 'utf8');
    const indexBefore = await fs.readFile(paths.chatsIndex, 'utf8');

    await expect(storage.chats.update(chat.id, { archived: true })).rejects.toMatchObject({
      code: 'conflict',
      message: NOT_ARCHIVABLE,
    });
    expect(await fs.readFile(paths.chatFile(chat.id), 'utf8')).toBe(fileBefore);
    expect(await fs.readFile(paths.chatsIndex, 'utf8')).toBe(indexBefore);
    expect((await storage.chats.get(chat.id)).archived).toBe(false);
    await expectInSync(dataDir, chat.id);
  });

  it('update({ projectId, archived: true }) on a loose chat is a conflict and the chat stays loose and unarchived', async () => {
    const { storage, dataDir } = await makeStorage();
    const project = await storage.projects.create({ rootPath: await makeTempDir() });
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    const paths = dataPaths(dataDir);
    const fileBefore = await fs.readFile(paths.chatFile(chat.id), 'utf8');
    const indexBefore = await fs.readFile(paths.chatsIndex, 'utf8');

    await expect(storage.chats.update(chat.id, { projectId: project.id, archived: true })).rejects.toMatchObject({
      code: 'conflict',
      message: NOT_ARCHIVABLE,
    });
    const after = await storage.chats.get(chat.id);
    expect(after).toMatchObject({ projectId: null, archived: false });
    expect(await fs.readFile(paths.chatFile(chat.id), 'utf8')).toBe(fileBefore);
    expect(await fs.readFile(paths.chatsIndex, 'utf8')).toBe(indexBefore);
    await expectInSync(dataDir, chat.id);
  });

  it('moving an archived chat into a project clears the flag; moving it out leaves a chat archived', async () => {
    const { storage, dataDir } = await makeStorage();
    const project = await storage.projects.create({ rootPath: await makeTempDir() });
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.update(chat.id, { archived: true });
    await expectInSync(dataDir, chat.id);

    const moved = await storage.chats.update(chat.id, { projectId: project.id });
    expect(moved).toMatchObject({ projectId: project.id, archived: false });
    expect((await storage.chats.get(chat.id)).archived).toBe(false);
    expect((await readRawChat(dataDir, chat.id)).archived).toBe(false);
    expect((await readRawEntry(dataDir, chat.id)).archived).toBe(false);
    await expectInSync(dataDir, chat.id);

    // Back to loose: unarchived stays unarchived.
    const loose = await storage.chats.update(chat.id, { projectId: null });
    expect(loose).toMatchObject({ projectId: null, archived: false });
    await expectInSync(dataDir, chat.id);

    // An archived loose chat patched with projectId: null stays archived.
    await storage.chats.update(chat.id, { archived: true });
    const stillArchived = await storage.chats.update(chat.id, { projectId: null });
    expect(stillArchived.archived).toBe(true);
    expect((await storage.chats.get(chat.id)).archived).toBe(true);
    await expectInSync(dataDir, chat.id);
  });

  it('appendMessage, truncateAfterLastUser, model and title updates keep an archived chat archived', async () => {
    const { storage, dataDir } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm1' });
    await storage.chats.appendMessage(chat.id, user('u1'));
    await storage.chats.update(chat.id, { archived: true });
    await expectInSync(dataDir, chat.id);

    const appended = await storage.chats.appendMessage(chat.id, assistant('a1'));
    expect(appended.archived).toBe(true);
    await expectInSync(dataDir, chat.id);
    expect((await readRawChat(dataDir, chat.id)).archived).toBe(true);
    expect((await readRawEntry(dataDir, chat.id)).archived).toBe(true);

    await storage.chats.appendMessage(chat.id, user('u2'));
    await storage.chats.appendMessage(chat.id, assistant('a2'));
    const cut = await storage.chats.truncateAfterLastUser(chat.id);
    expect(cut.archived).toBe(true);
    expect(cut.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    await expectInSync(dataDir, chat.id);
    expect((await readRawChat(dataDir, chat.id)).archived).toBe(true);
    expect((await readRawEntry(dataDir, chat.id)).archived).toBe(true);

    const modelChanged = await storage.chats.update(chat.id, { model: 'm2' });
    expect(modelChanged.archived).toBe(true);
    await expectInSync(dataDir, chat.id);
    expect((await readRawChat(dataDir, chat.id)).archived).toBe(true);

    const renamed = await storage.chats.update(chat.id, { title: 'Renamed' });
    expect(renamed.archived).toBe(true);
    await expectInSync(dataDir, chat.id);
    expect((await readRawChat(dataDir, chat.id)).archived).toBe(true);
    expect((await readRawEntry(dataDir, chat.id)).archived).toBe(true);
  });

  it('keeps every message and the archived flag when appends race an archive', async () => {
    const { storage, dataDir } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      calls.push(storage.chats.appendMessage(chat.id, user(`u${i}`)));
      if (i === 9) calls.push(storage.chats.update(chat.id, { archived: true }));
    }
    await Promise.all(calls);
    const loaded = await storage.chats.get(chat.id);
    expect(loaded.messages.map((m) => m.id)).toEqual(Array.from({ length: 20 }, (_, i) => `u${i}`));
    expect(loaded.archived).toBe(true);
    await expectInSync(dataDir, chat.id);
    expect((await readRawChat(dataDir, chat.id)).archived).toBe(true);
    expect((await readRawEntry(dataDir, chat.id)).archived).toBe(true);
  });

  it('a rebuilt index (missing) keeps the flag and writes it back', async () => {
    const { storage, dataDir } = await makeStorage();
    const a = await storage.chats.create({ projectId: null, model: 'm' });
    const b = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.update(a.id, { archived: true });
    await fs.rm(dataPaths(dataDir).chatsIndex);

    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore() });
    const listed = await fresh.chats.list();
    expect(listed.find((c) => c.id === a.id)?.archived).toBe(true);
    expect(listed.find((c) => c.id === b.id)?.archived).toBe(false);
    expect((await readRawEntry(dataDir, a.id)).archived).toBe(true);
    expect((await readRawEntry(dataDir, b.id)).archived).toBe(false);
    await expectInSync(dataDir, a.id);
  });

  it('a rebuilt index (corrupt, backed up) keeps the flag and writes it back', async () => {
    const { storage, dataDir } = await makeStorage();
    const a = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.update(a.id, { archived: true });
    await fs.writeFile(dataPaths(dataDir).chatsIndex, '{{{{');

    const logger = recordingLogger();
    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore(), logger });
    expect((await fresh.chats.list()).find((c) => c.id === a.id)?.archived).toBe(true);
    expect((await readRawEntry(dataDir, a.id)).archived).toBe(true);
    expect((await names(dataDir)).some((n) => n.startsWith('index.json.corrupt-'))).toBe(true);
    await expectInSync(dataDir, a.id);
  });

  it('hand-written files and index without the flag load as unarchived, messages intact, nothing quarantined', async () => {
    const { dataDir } = await makeStorage();
    const paths = dataPaths(dataDir);
    await fs.mkdir(paths.chatsDir, { recursive: true });
    const file = handChat('hand');
    await fs.writeFile(paths.chatFile('hand'), JSON.stringify(file));
    const { version: _v, messages: _m, ...entry } = file;
    await fs.writeFile(paths.chatsIndex, JSON.stringify({ version: 1, chats: [entry] }));

    const logger = recordingLogger();
    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore(), logger });
    const listed = await fresh.chats.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'hand', archived: false });
    const loaded = await fresh.chats.get('hand');
    expect(loaded.archived).toBe(false);
    expect(loaded.messages.map((m) => m.id)).toEqual(['hand-u', 'hand-a']);
    expect((await names(dataDir)).some((n) => n.includes('.corrupt-'))).toBe(false);
    expect(logger.messages).toEqual([]);

    // Same again with the index missing: the rebuild scans the hand-written file.
    await fs.rm(paths.chatsIndex);
    const logger2 = recordingLogger();
    const rebuilt = await createStorage({ dataDir, secretStore: new MemorySecretStore(), logger: logger2 });
    const relisted = await rebuilt.chats.list();
    expect(relisted).toHaveLength(1);
    expect(relisted[0]).toMatchObject({ id: 'hand', archived: false });
    expect((await rebuilt.chats.get('hand')).messages.map((m) => m.id)).toEqual(['hand-u', 'hand-a']);
    expect((await names(dataDir)).some((n) => n.includes('.corrupt-'))).toBe(false);
    expect(logger2.messages).toEqual([]);
  });

  it('a malformed flag ("yes") loads as unarchived, is not quarantined, and keeps the messages', async () => {
    const { dataDir } = await makeStorage();
    const paths = dataPaths(dataDir);
    await fs.mkdir(paths.chatsDir, { recursive: true });
    await fs.writeFile(paths.chatFile('odd'), JSON.stringify(handChat('odd', { archived: 'yes' })));
    await fs.rm(paths.chatsIndex, { force: true });

    const logger = recordingLogger();
    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore(), logger });
    const loaded = await fresh.chats.get('odd');
    expect(loaded.archived).toBe(false);
    expect(loaded.messages.map((m) => m.id)).toEqual(['odd-u', 'odd-a']);
    expect((await fresh.chats.list()).map((c) => [c.id, c.archived])).toEqual([['odd', false]]);
    expect((await names(dataDir)).some((n) => n.includes('.corrupt-'))).toBe(false);
    expect(logger.messages).toEqual([]);
  });

  it('archiving again repairs an index entry that disagrees with the file', async () => {
    const { storage, dataDir } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.update(chat.id, { archived: true });
    const paths = dataPaths(dataDir);
    const index = JSON.parse(await fs.readFile(paths.chatsIndex, 'utf8'));
    index.chats[0].archived = false;
    await fs.writeFile(paths.chatsIndex, JSON.stringify(index));
    expect((await readRawEntry(dataDir, chat.id)).archived).toBe(false);
    expect((await readRawChat(dataDir, chat.id)).archived).toBe(true);

    const again = await storage.chats.update(chat.id, { archived: true });
    expect(again.archived).toBe(true);
    expect((await readRawEntry(dataDir, chat.id)).archived).toBe(true);
    await expectInSync(dataDir, chat.id);
  });

  it('detachProject leaves the moved chats unarchived', async () => {
    const { storage, dataDir } = await makeStorage();
    const project = await storage.projects.create({ rootPath: await makeTempDir() });
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.update(chat.id, { archived: true });
    await storage.chats.update(chat.id, { projectId: project.id });
    const other = await storage.chats.create({ projectId: project.id, model: 'm' });

    await storage.chats.detachProject(project.id);
    for (const id of [chat.id, other.id]) {
      expect(await storage.chats.get(id)).toMatchObject({ projectId: null, archived: false });
      await expectInSync(dataDir, id);
    }
    expect((await storage.chats.list()).every((c) => c.archived === false)).toBe(true);
  });
});

describe('ChatsService usage (F1)', () => {
  const withUsage = (msg: AssistantMessage, usage: Usage): AssistantMessage => ({ ...msg, usage });
  const toolResult = (id: string, toolCallId: string): Message => ({
    id,
    role: 'tool',
    createdAt: NOW,
    toolCallId,
    name: 'read_file',
    ok: true,
    output: 'x',
    summary: 'x',
    durationMs: 1,
  });

  it('a new chat has no requests and an empty context, in the return value and the index', async () => {
    const { storage } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    const zero = { contextTokens: 0, promptTokens: 0, completionTokens: 0, costUsd: null, requests: 0 };
    expect(chat.usage).toEqual(zero);
    expect((await storage.chats.list())[0]?.usage).toEqual(zero);
  });

  it('create, get and truncate hide the internal usageTotals; the file keeps it', async () => {
    const { storage, dataDir } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    expect(chat).not.toHaveProperty('usageTotals');
    expect(await storage.chats.get(chat.id)).not.toHaveProperty('usageTotals');
    expect((await readRawChat(dataDir, chat.id)).usageTotals).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      requests: 0,
    });

    await storage.chats.appendMessage(chat.id, user('u1'));
    await storage.chats.appendMessage(chat.id, withUsage(assistant('a1'), { promptTokens: 100, completionTokens: 10 }));
    await storage.chats.appendMessage(chat.id, user('u2'));
    await storage.chats.appendMessage(chat.id, withUsage(assistant('a2'), { promptTokens: 200, completionTokens: 20 }));
    const cut = await storage.chats.truncateAfterLastUser(chat.id);
    expect(cut).not.toHaveProperty('usageTotals');
    expect(cut.usage).toMatchObject({ contextTokens: 110, requests: 2 });
    expect((await readRawChat(dataDir, chat.id)).usageTotals).toEqual({
      promptTokens: 300,
      completionTokens: 30,
      costUsd: null,
      requests: 2,
    });
  });

  it('totals add up across the steps of a tool turn', async () => {
    const { storage } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.appendMessage(chat.id, user('u1'));
    await storage.chats.appendMessage(chat.id, {
      ...assistant('a1'),
      toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"README.md"}' }],
      usage: { promptTokens: 120, completionTokens: 48 },
    });
    await storage.chats.appendMessage(chat.id, toolResult('t1', 'c1'));
    const after = await storage.chats.appendMessage(chat.id, {
      ...assistant('a2'),
      usage: { promptTokens: 150, completionTokens: 30, costUsd: 0.002 },
    });

    const expected = { contextTokens: 180, promptTokens: 270, completionTokens: 78, costUsd: 0.002, requests: 2 };
    expect(after.usage).toEqual(expected);
    expect((await storage.chats.get(chat.id)).usage).toEqual(expected);
    expect((await storage.chats.list())[0]?.usage).toEqual(expected);
  });

  it('a retry keeps the discarded turn in the totals, and contextTokens follows the new latest reply', async () => {
    const { storage } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.appendMessage(chat.id, user('u1'));
    await storage.chats.appendMessage(chat.id, withUsage(assistant('a1'), { promptTokens: 100, completionTokens: 10 }));
    await storage.chats.appendMessage(chat.id, user('u2'));
    await storage.chats.appendMessage(chat.id, withUsage(assistant('a2'), { promptTokens: 200, completionTokens: 20 }));

    // The retry drops the last reply from the messages. The totals keep it, and the context falls back to a1.
    const cut = await storage.chats.truncateAfterLastUser(chat.id);
    expect(cut.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    expect(cut.usage).toEqual({
      contextTokens: 110,
      promptTokens: 300,
      completionTokens: 30,
      costUsd: null,
      requests: 2,
    });

    const retried = await storage.chats.appendMessage(
      chat.id,
      withUsage(assistant('a3'), { promptTokens: 150, completionTokens: 15 }),
    );
    expect(retried.usage).toEqual({
      contextTokens: 165,
      promptTokens: 450,
      completionTokens: 45,
      costUsd: null,
      requests: 3,
    });
    expect((await storage.chats.get(chat.id)).usage).toEqual(retried.usage);
  });

  it('truncateAfterLastUser refreshes the index, so list() shows the new contextTokens', async () => {
    const { storage } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.appendMessage(chat.id, user('u1'));
    await storage.chats.appendMessage(chat.id, withUsage(assistant('a1'), { promptTokens: 100, completionTokens: 10 }));
    await storage.chats.appendMessage(chat.id, user('u2'));
    await storage.chats.appendMessage(chat.id, withUsage(assistant('a2'), { promptTokens: 200, completionTokens: 20 }));
    expect((await storage.chats.list())[0]?.usage.contextTokens).toBe(220);

    const cut = await storage.chats.truncateAfterLastUser(chat.id);
    expect(cut.usage.contextTokens).toBe(110);
    expect((await storage.chats.list())[0]?.usage).toEqual(cut.usage);
  });

  it('rename, move and detachProject keep the totals after a truncate; they are never re-backfilled', async () => {
    const { storage, dataDir } = await makeStorage();
    const project = await storage.projects.create({ rootPath: await makeTempDir() });
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.appendMessage(chat.id, user('u1'));
    await storage.chats.appendMessage(chat.id, withUsage(assistant('a1'), { promptTokens: 100, completionTokens: 10 }));
    await storage.chats.appendMessage(chat.id, user('u2'));
    await storage.chats.appendMessage(chat.id, withUsage(assistant('a2'), { promptTokens: 200, completionTokens: 20 }));
    await storage.chats.truncateAfterLastUser(chat.id);
    const expectedTotals = { promptTokens: 300, completionTokens: 30, costUsd: null, requests: 2 };

    await storage.chats.update(chat.id, { title: 'Renamed' });
    expect((await readRawChat(dataDir, chat.id)).usageTotals).toEqual(expectedTotals);
    expect((await storage.chats.list())[0]?.usage).toMatchObject({ contextTokens: 110, ...expectedTotals });

    await storage.chats.update(chat.id, { projectId: project.id });
    expect((await readRawChat(dataDir, chat.id)).usageTotals).toEqual(expectedTotals);
    expect((await storage.chats.list())[0]?.usage).toMatchObject({ contextTokens: 110, ...expectedTotals });

    await storage.chats.detachProject(project.id);
    expect((await readRawChat(dataDir, chat.id)).usageTotals).toEqual(expectedTotals);
    expect((await storage.chats.list())[0]?.usage).toMatchObject({ contextTokens: 110, ...expectedTotals });

    // Later replies add to the kept totals rather than restarting them from the remaining messages.
    const next = await storage.chats.appendMessage(
      chat.id,
      withUsage(assistant('a3'), { promptTokens: 150, completionTokens: 15 }),
    );
    expect(next.usage).toEqual({
      contextTokens: 165,
      promptTokens: 450,
      completionTokens: 45,
      costUsd: null,
      requests: 3,
    });
  });

  it('a stopped reply counts when it reported usage; one without usage does not', async () => {
    const { storage } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.appendMessage(chat.id, user('u1'));
    const stopped = await storage.chats.appendMessage(chat.id, {
      ...withUsage(assistant('a1'), { promptTokens: 80, completionTokens: 20 }),
      status: 'stopped',
      text: 'Partial',
    });
    expect(stopped.usage).toEqual({
      contextTokens: 100,
      promptTokens: 80,
      completionTokens: 20,
      costUsd: null,
      requests: 1,
    });

    const bare = await storage.chats.appendMessage(chat.id, { ...assistant('a2'), status: 'stopped' });
    expect(bare.usage).toEqual(stopped.usage);
  });

  it('costUsd stays null while no request reports a cost, and sums the ones that do', async () => {
    const { storage } = await makeStorage();
    const quiet = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.appendMessage(quiet.id, withUsage(assistant('q1'), { promptTokens: 10, completionTokens: 5 }));
    const q = await storage.chats.appendMessage(
      quiet.id,
      withUsage(assistant('q2'), { promptTokens: 10, completionTokens: 5 }),
    );
    expect(q.usage).toMatchObject({ costUsd: null, requests: 2 });

    const mixed = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.appendMessage(
      mixed.id,
      withUsage(assistant('m1'), { promptTokens: 10, completionTokens: 5, costUsd: 0.1 }),
    );
    await storage.chats.appendMessage(mixed.id, withUsage(assistant('m2'), { promptTokens: 10, completionTokens: 5 }));
    const m = await storage.chats.appendMessage(
      mixed.id,
      withUsage(assistant('m3'), { promptTokens: 10, completionTokens: 5, costUsd: 0.2 }),
    );
    expect(m.usage.costUsd).toBeCloseTo(0.3, 10);
    expect(m.usage.requests).toBe(3);
  });

  it('a chat file from before F1 (no usageTotals) is backfilled from its messages, once', async () => {
    const { dataDir } = await makeStorage();
    const paths = dataPaths(dataDir);
    await fs.mkdir(paths.chatsDir, { recursive: true });
    // Written before F1: no `usageTotals`, no `usage`, and no index.
    const legacy = {
      version: 1,
      id: 'legacy',
      projectId: null,
      title: 'Old chat',
      model: 'm',
      createdAt: NOW,
      updatedAt: NOW,
      archived: false,
      messages: [
        user('l-u1'),
        withUsage(assistant('l-a1'), { promptTokens: 120, completionTokens: 48 }),
        toolResult('l-t1', 'c'),
        withUsage(assistant('l-a2'), { promptTokens: 130, completionTokens: 40, costUsd: 0.01 }),
      ],
    };
    await fs.writeFile(paths.chatFile('legacy'), JSON.stringify(legacy));
    await fs.rm(paths.chatsIndex, { force: true });

    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore() });
    const expected = { contextTokens: 170, promptTokens: 250, completionTokens: 88, costUsd: 0.01, requests: 2 };
    expect((await fresh.chats.get('legacy')).usage).toEqual(expected);
    expect((await fresh.chats.list())[0]?.usage).toEqual(expected);

    // The next reply adds to the backfilled totals, and nothing is counted twice.
    const next = await fresh.chats.appendMessage(
      'legacy',
      withUsage(assistant('l-a3'), { promptTokens: 10, completionTokens: 5 }),
    );
    expect(next.usage).toEqual({
      contextTokens: 15,
      promptTokens: 260,
      completionTokens: 93,
      costUsd: 0.01,
      requests: 3,
    });
  });

  it('a malformed usageTotals is backfilled from the messages, not quarantined', async () => {
    const { dataDir } = await makeStorage();
    const paths = dataPaths(dataDir);
    await fs.mkdir(paths.chatsDir, { recursive: true });
    const malformed = handChat('odd', {
      usageTotals: 'not an object',
      messages: [
        user('odd-u'),
        withUsage(assistant('odd-a'), { promptTokens: 120, completionTokens: 48, costUsd: 0.01 }),
      ],
    });
    await fs.writeFile(paths.chatFile('odd'), JSON.stringify(malformed));
    await fs.rm(paths.chatsIndex, { force: true });

    const logger = recordingLogger();
    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore(), logger });
    const expected = { contextTokens: 168, promptTokens: 120, completionTokens: 48, costUsd: 0.01, requests: 1 };
    expect((await fresh.chats.get('odd')).usage).toEqual(expected);
    expect((await fresh.chats.list())[0]?.usage).toEqual(expected);
    expect((await names(dataDir)).some((n) => n.includes('.corrupt-'))).toBe(false);
    expect(logger.messages).toEqual([]);

    // A later write replaces the malformed value with the backfilled object.
    const next = await fresh.chats.appendMessage(
      'odd',
      withUsage(assistant('odd-a2'), { promptTokens: 10, completionTokens: 5 }),
    );
    expect(next.usage).toMatchObject({ promptTokens: 130, completionTokens: 53, requests: 2 });
    expect((await readRawChat(dataDir, 'odd')).usageTotals).toEqual({
      promptTokens: 130,
      completionTokens: 53,
      costUsd: 0.01,
      requests: 2,
    });
  });

  it('an index written before F1 is rebuilt, so its summaries carry usage', async () => {
    const { storage, dataDir } = await makeStorage();
    const chat = await storage.chats.create({ projectId: null, model: 'm' });
    await storage.chats.appendMessage(chat.id, user('u1'));
    await storage.chats.appendMessage(chat.id, withUsage(assistant('a1'), { promptTokens: 100, completionTokens: 20 }));

    // Rewrite the index in its pre-F1 shape: no `usage` on the entries and no `usageBackfilled` marker.
    const paths = dataPaths(dataDir);
    const old = JSON.parse(await fs.readFile(paths.chatsIndex, 'utf8')) as { chats: Record<string, unknown>[] };
    await fs.writeFile(
      paths.chatsIndex,
      JSON.stringify({ version: 1, chats: old.chats.map(({ usage: _usage, ...entry }) => entry) }),
    );

    const fresh = await createStorage({ dataDir, secretStore: new MemorySecretStore() });
    expect((await fresh.chats.list()).find((c) => c.id === chat.id)?.usage).toEqual({
      contextTokens: 120,
      promptTokens: 100,
      completionTokens: 20,
      costUsd: null,
      requests: 1,
    });
    // The rebuilt index was written back in the F1 shape.
    const rewritten = JSON.parse(await fs.readFile(paths.chatsIndex, 'utf8')) as {
      usageBackfilled?: boolean;
      chats: { usage?: { requests: number } }[];
    };
    expect(rewritten.usageBackfilled).toBe(true);
    expect(rewritten.chats[0]?.usage?.requests).toBe(1);
  });
});
