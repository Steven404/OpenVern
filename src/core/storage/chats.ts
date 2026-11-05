// ChatsService (plan S1.6): `chats/<id>.json` plus `chats/index.json`, which mirrors every chat's summary and
// is rebuilt by scanning `chats/` when missing or corrupt.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { NEW_CHAT_TITLE } from '@shared/constants';
import type { ChatSummary, Id } from '@shared/types';
import { CoreError } from '../errors';
import type { ChatsService } from '../types';
import { JsonFile, type StorageLogger } from './json-file';
import { createMutex } from './mutex';
import { type DataPaths, dataPaths } from './paths';
import {
  addUsage,
  type ChatIndexFile,
  chatFileSchema,
  chatIndexSchema,
  type StoredChat,
  summarize,
  withUsage,
} from './schemas';

export interface ChatsServiceOptions {
  /** Absolute data dir (the tree must exist; see `ensureDataDir`). */
  dataDir: string;
  /** Lets `create` / `update` reject unknown project ids with `not_found`. Omit to skip the check. */
  projectExists?: (projectId: Id) => Promise<boolean>;
  logger?: StorageLogger;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
// `index` would map onto chats/index.json, the index file itself.
const isChatId = (id: string) => SAFE_ID.test(id) && id !== 'index';

const notFound = () => new CoreError('not_found', 'Chat not found.');
const byRecency = (a: ChatSummary, b: ChatSummary) =>
  b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt);

/** On-disk shape of a chat file. */
type ChatFile = StoredChat & { version: 1 };
const toFile = (chat: StoredChat): ChatFile => ({ version: 1, ...chat });
const writeIndexFile = (chats: ChatSummary[]): ChatIndexFile => ({ version: 1, chats, usageBackfilled: true });

export function createChatsService(opts: ChatsServiceOptions): ChatsService {
  const paths: DataPaths = dataPaths(opts.dataDir);
  const fileOpts = { logger: opts.logger };
  const index = new JsonFile<ChatIndexFile>(paths.chatsIndex, chatIndexSchema, fileOpts);
  // One lock for every mutation: chat file + index must change together, and contention is negligible.
  const lock = createMutex();

  const chatFile = (id: Id) => {
    if (!isChatId(id)) throw notFound();
    return new JsonFile<StoredChat, ChatFile>(paths.chatFile(id), chatFileSchema, fileOpts);
  };

  const readChat = async (id: Id): Promise<StoredChat> => {
    const chat = await chatFile(id).read();
    if (!chat) throw notFound();
    return chat;
  };

  const writeChat = (chat: StoredChat) => chatFile(chat.id).write(toFile(chat));

  async function rebuildIndex(): Promise<ChatSummary[]> {
    const names = await fs.readdir(paths.chatsDir).catch(() => [] as string[]);
    const summaries: ChatSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const id = name.slice(0, -'.json'.length);
      if (!isChatId(id)) continue;
      const chat = await chatFile(id).read();
      if (chat && chat.id === id) summaries.push(summarize(chat));
    }
    summaries.sort(byRecency);
    await index.write(writeIndexFile(summaries));
    return summaries;
  }

  /** Index entries, rebuilding from disk if the index is missing, corrupt or predates F1's `usage`. */
  async function loadIndex(): Promise<ChatSummary[]> {
    const current = await index.read();
    return current?.usageBackfilled ? current.chats : rebuildIndex();
  }

  const saveIndex = (chats: ChatSummary[]) => index.write(writeIndexFile(chats));

  async function upsertIndex(summary: ChatSummary): Promise<void> {
    const chats = await loadIndex();
    const at = chats.findIndex((c) => c.id === summary.id);
    if (at >= 0) chats[at] = summary;
    else chats.push(summary);
    await saveIndex(chats);
  }

  async function assertProject(projectId: Id | null | undefined): Promise<void> {
    if (projectId && opts.projectExists && !(await opts.projectExists(projectId))) {
      throw new CoreError('not_found', 'Project not found.');
    }
  }

  return {
    async list() {
      // Rebuilding writes, so serialise with mutations; the common path is a plain read.
      const chats = await lock.run(loadIndex);
      return [...chats].sort(byRecency);
    },

    get: readChat,

    async create(input) {
      await assertProject(input.projectId);
      const now = new Date().toISOString();
      const chat: StoredChat = withUsage({
        id: randomUUID(),
        projectId: input.projectId,
        title: NEW_CHAT_TITLE,
        model: input.model,
        createdAt: now,
        updatedAt: now,
        archived: false,
        messages: [],
      });
      return lock.run(async () => {
        await writeChat(chat);
        await upsertIndex(summarize(chat));
        return chat;
      });
    },

    async update(id, patch) {
      await assertProject(patch.projectId);
      return lock.run(async () => {
        const chat = await readChat(id);
        const next: StoredChat = { ...chat };
        if (patch.title !== undefined) next.title = patch.title;
        if (patch.projectId !== undefined) next.projectId = patch.projectId;
        if (patch.model !== undefined && patch.model !== chat.model) {
          next.model = patch.model;
          next.updatedAt = new Date().toISOString();
        }
        if (next.projectId !== null) {
          if (patch.archived === true) {
            throw new CoreError('conflict', 'Only chats without a project can be archived.');
          }
          // Moving into a project clears the flag.
          next.archived = false;
        } else if (patch.archived !== undefined) {
          next.archived = patch.archived;
        }
        await writeChat(next);
        const summary = summarize(next);
        await upsertIndex(summary);
        return summary;
      });
    },

    async remove(id) {
      if (!isChatId(id)) throw notFound();
      await lock.run(async () => {
        const removed = await chatFile(id).delete();
        const chats = await loadIndex();
        const kept = chats.filter((c) => c.id !== id);
        if (kept.length !== chats.length) await saveIndex(kept);
        else if (!removed) throw notFound();
      });
    },

    appendMessage(chatId, message) {
      return lock.run(async () => {
        const chat = await readChat(chatId);
        // An assistant message with usage adds to the cumulative counters; a retry later keeps them (plan §2).
        const usageTotals =
          message.role === 'assistant' && message.usage ? addUsage(chat.usageTotals, message.usage) : chat.usageTotals;
        const next = withUsage({
          ...chat,
          messages: [...chat.messages, message],
          usageTotals,
          updatedAt: new Date().toISOString(),
        });
        await writeChat(next);
        const summary = summarize(next);
        await upsertIndex(summary);
        return summary;
      });
    },

    truncateAfterLastUser(chatId) {
      return lock.run(async () => {
        const chat = await readChat(chatId);
        const lastUser = chat.messages.findLastIndex((m) => m.role === 'user');
        if (lastUser < 0 || lastUser === chat.messages.length - 1) return chat;
        const next = withUsage({ ...chat, messages: chat.messages.slice(0, lastUser + 1) });
        await writeChat(next);
        return next;
      });
    },

    detachProject(projectId) {
      return lock.run(async () => {
        const chats = await loadIndex();
        let changed = false;
        for (const [i, summary] of chats.entries()) {
          if (summary.projectId !== projectId) continue;
          const chat = await readChat(summary.id).catch((err) => {
            if (err instanceof CoreError && err.code === 'not_found') return null;
            throw err;
          });
          if (!chat) continue;
          const next = withUsage({ ...chat, projectId: null });
          await writeChat(next);
          chats[i] = summarize(next);
          changed = true;
        }
        if (changed) await saveIndex(chats);
      });
    },
  };
}
