import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NEW_CHAT_TITLE } from '@shared/constants';
import type { AssistantMessage, Message, UserMessage } from '@shared/types';
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
    for (const id of ['missing', '../secrets', 'a/b']) {
      await expect(storage.chats.get(id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(storage.chats.update(id, { title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(storage.chats.remove(id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(storage.chats.appendMessage(id, user('u'))).rejects.toMatchObject({ code: 'not_found' });
      await expect(storage.chats.truncateAfterLastUser(id)).rejects.toMatchObject({ code: 'not_found' });
    }
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
});
