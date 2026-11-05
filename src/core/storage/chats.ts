// ChatsService (plan S1.6): `chats/<id>.json` plus `chats/index.json`, which mirrors every chat's summary and
// is rebuilt by scanning `chats/` when missing or corrupt.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { NEW_CHAT_TITLE } from '@shared/constants';
import type { Chat, ChatSummary, Id } from '@shared/types';
import { CoreError } from '../errors';
import type { ChatsService } from '../types';
import { consoleLogger, isNotFound, JsonFile, type StorageLogger } from './json-file';
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
/** What the API returns: the stored chat without the internal cumulative counters (plan §4.3). */
const toChat = ({ usageTotals: _usageTotals, ...chat }: StoredChat): Chat => chat;
/**
 * `complete: false` (a rebuild skipped an unreadable chat file) leaves out the `usageBackfilled` marker, so the
 * next load rebuilds from disk again instead of hiding that chat for good.
 */
const writeIndexFile = (chats: ChatSummary[], complete: boolean): ChatIndexFile =>
  complete ? { version: 1, chats, usageBackfilled: true } : { version: 1, chats };

/**
 * Index entries; `complete` is false when a rebuild had to skip an unreadable chat file. `listingFailed` means
 * `chats/` itself couldn't be listed, so `chats` may be missing any number of chats.
 */
type LoadedIndex = { chats: ChatSummary[]; complete: boolean; listingFailed?: boolean };

export function createChatsService(opts: ChatsServiceOptions): ChatsService {
  const paths: DataPaths = dataPaths(opts.dataDir);
  const logger = opts.logger ?? consoleLogger;
  const fileOpts = { logger };
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

  /**
   * Callers must not run two ChatsServices on the same data dir at once: an unmarked index written by another
   * instance is ignored in favour of this until the next list() rebuild (the index diverges, no chat is lost).
   * The summaries of the last rebuild that skipped an unreadable chat file, kept in step by mutations. Mutations
   * use them instead of re-scanning every chat file on each write; only `list()` retries the full rebuild.
   */
  let partial: LoadedIndex | null = null;
  /** Unreadable entries already logged, so a file that stays unreadable is reported once per process. */
  const warned = new Set<string>();
  let warnedListing = false;

  async function rebuildIndex(): Promise<LoadedIndex> {
    const summaries: ChatSummary[] = [];
    let skipped = false;
    let listingFailed = false;
    let names: string[] = [];
    try {
      names = await fs.readdir(paths.chatsDir);
    } catch (err) {
      // A missing dir is a clean, empty data dir. Any other error (EACCES, EMFILE…) must not produce a "complete"
      // empty index, which would hide every chat for good: treat it as a partial rebuild so list() retries.
      if (!isNotFound(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!warnedListing) logger.warn(`chats/ could not be listed (${reason}); the chat list may be incomplete.`);
        warnedListing = true;
        skipped = true;
        listingFailed = true;
      }
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const id = name.slice(0, -'.json'.length);
      if (!isChatId(id)) continue;
      let chat: StoredChat | null;
      try {
        chat = await chatFile(id).read();
      } catch (err) {
        // One unreadable entry must not make every list() fail; skip it and say which one.
        const reason = err instanceof Error ? err.message : String(err);
        if (!warned.has(name)) logger.warn(`chats/${name} could not be read (${reason}); skipped.`);
        warned.add(name);
        skipped = true;
        continue;
      }
      if (chat && chat.id === id) summaries.push(summarize(chat));
    }
    summaries.sort(byRecency);
    // The error may be transient (EACCES, EMFILE, EBUSY…): persisting this index would hide the skipped chat for
    // good, so only a clean rebuild is written; otherwise the next list() retries.
    // Set before the write, so a failed write can't leave an older partial index in place.
    partial = skipped ? { chats: [...summaries], complete: false, listingFailed } : null;
    if (!skipped) {
      warned.clear();
      warnedListing = false;
      await index.write(writeIndexFile(summaries, true));
    }
    return { chats: summaries, complete: !skipped, listingFailed };
  }

  /**
   * Index entries, rebuilding from disk if the index is missing, corrupt or predates F1's `usage`. After a partial
   * rebuild, mutations reuse the in-memory result; `retry` (used by `list()`) rebuilds again instead.
   */
  async function loadIndex({ retry = false }: { retry?: boolean } = {}): Promise<LoadedIndex> {
    const current = await index.read();
    if (current?.usageBackfilled) {
      partial = null;
      return { chats: current.chats, complete: true };
    }
    if (partial && !retry) return { ...partial, chats: [...partial.chats] };
    return rebuildIndex();
  }

  const saveIndex = async ({ chats, complete, listingFailed }: LoadedIndex) => {
    await index.write(writeIndexFile(chats, complete));
    partial = complete ? null : { chats: [...chats], complete: false, listingFailed };
  };

  async function upsertIndex(summary: ChatSummary): Promise<void> {
    const loaded = await loadIndex();
    const { chats } = loaded;
    const at = chats.findIndex((c) => c.id === summary.id);
    if (at >= 0) chats[at] = summary;
    else chats.push(summary);
    await saveIndex(loaded);
  }

  async function assertProject(projectId: Id | null | undefined): Promise<void> {
    if (projectId && opts.projectExists && !(await opts.projectExists(projectId))) {
      throw new CoreError('not_found', 'Project not found.');
    }
  }

  return {
    async list() {
      // Rebuilding writes, so serialise with mutations; the common path is a plain read.
      const { chats } = await lock.run(() => loadIndex({ retry: true }));
      return [...chats].sort(byRecency);
    },

    async get(id) {
      return toChat(await readChat(id));
    },

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
        return toChat(chat);
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
        const { chats, complete } = await loadIndex();
        const kept = chats.filter((c) => c.id !== id);
        if (kept.length !== chats.length) await saveIndex({ chats: kept, complete });
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
        if (lastUser < 0 || lastUser === chat.messages.length - 1) return toChat(chat);
        const next = withUsage({ ...chat, messages: chat.messages.slice(0, lastUser + 1) });
        await writeChat(next);
        await upsertIndex(summarize(next));
        return toChat(next);
      });
    },

    detachProject(projectId) {
      return lock.run(async () => {
        // Retry a failed rebuild; if chats/ still can't be listed, the project's chats are unknown, so refuse
        // rather than let the caller delete the project and leave its chats pointing at it.
        const loaded = await loadIndex({ retry: true });
        if (loaded.listingFailed) {
          throw new CoreError('conflict', "Some chats couldn't be read, so the project wasn't removed. Try again.");
        }
        const { chats } = loaded;
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
        if (changed) await saveIndex(loaded);
      });
    },
  };
}
