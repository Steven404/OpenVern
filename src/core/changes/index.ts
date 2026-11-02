// Change sets (v0.2 plan §3.2, §4.7): per-chat proposals that tools stage and the user applies.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import type {
  AppliedBatch,
  ApplyConflictReason,
  ChangeKind,
  ChangeSummary,
  ChatChanges,
  FileChange,
  HunkDecision,
  Id,
  PendingChanges,
} from '@shared/types';
import { z } from 'zod';
import { CoreError } from '../errors';
import { JsonFile, type StorageLogger, writeFileAtomic } from '../storage/json-file';
import { type DataPaths, dataPaths } from '../storage/paths';
import { resolveInProject, type SandboxOptions } from '../tools/sandbox';
import type { ToolChanges } from '../tools/types';
import type { ChangesService } from '../types';
import { applyHunks, detectEol, diffFile, finishFileChange, sameLines } from './diff';
import { buildNote, type ChangeEvent, type NoteFile } from './note';

export { applyHunks, diffFile } from './diff';

// ---------------------------------------------------------------------------------------------------- storage

const storedFileSchema = z.object({
  path: z.string(),
  baseHash: z.string(), // sha256 of the file's bytes when first touched, '' when it did not exist
  baseContent: z.string().nullable(),
  /** The base is a binary file (only deleting is allowed). */
  binary: z.boolean().optional(),
  content: z.string().nullable(),
  lastMessageId: z.string(),
});
type StoredFile = z.infer<typeof storedFileSchema>;

const hunkSchema = z.object({
  id: z.string(),
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  header: z.string(),
  lines: z.array(z.string()),
});
const fileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['create', 'modify', 'delete']),
  add: z.number(),
  del: z.number(),
  hunks: z.array(hunkSchema),
  tooLarge: z.boolean().optional(),
});
const batchSchema = z.object({
  id: z.string(),
  appliedAt: z.string(),
  messageId: z.string(),
  written: z.array(fileChangeSchema),
  rejectedHunks: z.number(),
  skippedHunks: z.number(),
  conflicts: z.array(
    z.object({
      path: z.string(),
      reason: z.enum(['changed_on_disk', 'deleted_on_disk', 'exists_on_disk', 'blocked']),
    }),
  ),
});
const noteFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['create', 'modify', 'delete']),
  accepted: z.number(),
  total: z.number(),
});
const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('applied'),
    written: z.array(noteFileSchema),
    rejected: z.array(noteFileSchema),
    skipped: z.array(noteFileSchema),
    conflicts: batchSchema.shape.conflicts,
  }),
  z.object({
    type: z.literal('discarded'),
    files: z.array(z.object({ path: z.string(), kind: z.enum(['create', 'modify', 'delete']) })),
  }),
]);
const snapshotSchema = z.object({
  userMessageId: z.string(),
  revision: z.number(),
  messageId: z.string(),
  files: z.array(storedFileSchema),
});
const storeSchema = z.object({
  version: z.literal(1),
  revision: z.number(),
  messageId: z.string(),
  files: z.array(storedFileSchema),
  snapshots: z.array(snapshotSchema),
  applied: z.array(batchSchema),
  events: z.array(eventSchema),
});
type Store = z.infer<typeof storeSchema>;

const emptyStore = (): Store => ({
  version: 1,
  revision: 0,
  messageId: '',
  files: [],
  snapshots: [],
  applied: [],
  events: [],
});

const MAX_SNAPSHOTS = 5;
const MAX_APPLIED = 100;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const PLACEHOLDER = /«redacted:[^»]*»/;

// ---------------------------------------------------------------------------------------------------- helpers

export interface ChangesServiceDeps {
  /** Absolute data dir (the tree must exist; see `ensureDataDir`). */
  dataDir: string;
  /** Sandbox options for project paths (denied roots / files such as the app's data dir and `secrets.json`). */
  sandbox?: SandboxOptions;
  logger?: StorageLogger;
  /** Test hooks. */
  now?: () => Date;
  newId?: () => string;
}

/**
 * The decision map that accepts every hunk of a pending set. Auto mode (a later version) applies a proposal straight
 * after staging with it; review mode never calls it.
 */
export function acceptAll(pending: Pick<PendingChanges, 'files'>): Record<string, Record<string, HunkDecision>> {
  const out: Record<string, Record<string, HunkDecision>> = {};
  for (const f of pending.files) out[f.path] = Object.fromEntries(f.hunks.map((h) => [h.id, 'accepted' as const]));
  return out;
}

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
const byPath = <T extends { path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const kindOf = (f: StoredFile): ChangeKind =>
  f.baseContent === null ? 'create' : f.content === null ? 'delete' : 'modify';

const fileChangeOf = (f: StoredFile): FileChange => diffFile(f.path, f.binary ? '' : f.baseContent, f.content);

function summaryOf(store: Store, files: FileChange[]): ChangeSummary | null {
  if (files.length === 0) return null;
  return {
    revision: store.revision,
    messageId: store.messageId,
    files: files.map((f) => ({ path: f.path, kind: f.kind, add: f.add, del: f.del })),
    totalAdd: files.reduce((n, f) => n + f.add, 0),
    totalDel: files.reduce((n, f) => n + f.del, 0),
  };
}

function pendingOf(store: Store): PendingChanges | null {
  if (store.files.length === 0) return null;
  const files = [...store.files].sort(byPath).map(fileChangeOf);
  return {
    revision: store.revision,
    messageId: store.messageId,
    files,
    totalAdd: files.reduce((n, f) => n + f.add, 0),
    totalDel: files.reduce((n, f) => n + f.del, 0),
  };
}

const chatChangesOf = (store: Store): ChatChanges => ({ pending: pendingOf(store), applied: store.applied });

function decodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

type Target =
  | { ok: true; abs: string; rel: string; exists: boolean; root: string }
  | { ok: false; kind: 'path' | 'link'; message: string };

/**
 * Resolves a path for writing. Like the read sandbox, plus: for a path that does not exist yet, its nearest existing
 * ancestor must be a real directory inside the root (no symlinked directory on the way), and an existing target must
 * not be reached through a symlink.
 */
async function resolveTarget(root: string, relPath: string, sandbox: SandboxOptions | undefined): Promise<Target> {
  const res = await resolveInProject(root, relPath, sandbox);
  if (!res.ok) return { ok: false, kind: 'path', message: res.message };
  if (res.rel === '') return { ok: false, kind: 'path', message: 'Path is the project folder itself' };
  if (res.exists) {
    const lexical = path.relative(res.root, path.resolve(res.root, relPath)).split(path.sep).join('/');
    const info = await fs.lstat(res.abs).catch(() => null);
    if (!info || info.isSymbolicLink() || lexical !== res.rel) {
      return { ok: false, kind: 'link', message: 'Path goes through a symbolic link' };
    }
    return { ok: true, abs: res.abs, rel: res.rel, exists: true, root: res.root };
  }
  let ancestor = path.dirname(res.abs);
  while (ancestor !== res.root) {
    const real = await fs.realpath(ancestor).catch(() => null);
    if (real !== null) {
      if (real !== ancestor) return { ok: false, kind: 'link', message: 'Path goes through a symbolic link' };
      break;
    }
    ancestor = path.dirname(ancestor);
  }
  return { ok: true, abs: res.abs, rel: res.rel, exists: false, root: res.root };
}

const badPath = (message: string) => new CoreError('path_invalid', message);

// ---------------------------------------------------------------------------------------------------- service

export function createChangesService(deps: ChangesServiceDeps): ChangesService {
  const paths: DataPaths = dataPaths(deps.dataDir);
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  const fileFor = (chatId: Id): JsonFile<Store> => {
    if (!SAFE_ID.test(chatId)) throw new CoreError('not_found', 'Chat not found.');
    return new JsonFile<Store>(paths.changesFile(chatId), storeSchema, { logger: deps.logger });
  };

  /** Read-modify-write under the file lock. `fn` may return `{ write: false }` to leave the file alone. */
  async function mutate<T>(chatId: Id, fn: (store: Store) => Promise<T> | T): Promise<T> {
    const file = fileFor(chatId);
    await fs.mkdir(paths.changesDir, { recursive: true });
    let result: T | undefined;
    await file.update(async (current) => {
      const store = current ?? emptyStore();
      result = await fn(store);
      return store;
    });
    return result as T;
  }

  async function load(chatId: Id): Promise<Store> {
    return (await fileFor(chatId).read()) ?? emptyStore();
  }

  function clearPending(store: Store): void {
    store.files = [];
    store.revision += 1;
  }

  // -------------------------------------------------------------------------------------------- staging

  async function stage(
    chatId: Id,
    projectRoot: string,
    messageId: Id,
    relPath: string,
    content: string | null,
  ): Promise<{ file: FileChange | null; summary: ChangeSummary | null }> {
    const target = await resolveTarget(projectRoot, relPath, deps.sandbox);
    if (!target.ok) throw badPath(target.kind === 'link' ? `${target.message}: ${relPath}` : target.message);
    const rel = target.rel;

    if (content !== null) {
      if (Buffer.byteLength(content) > LIMITS.writeFileMaxBytes) {
        throw new CoreError(
          'file_too_large',
          `The new content of ${rel} is over ${LIMITS.writeFileMaxBytes / 1024} KB.`,
        );
      }
      if (
        content.includes('\0') ||
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(content)
      ) {
        throw new CoreError('unsupported_file', `${rel}: only UTF-8 text can be written.`);
      }
      if (PLACEHOLDER.test(content)) {
        throw new CoreError(
          'invalid_request',
          `The content for ${rel} contains a «redacted:…» placeholder. Writing it back would destroy the real secret; use edit_file around it instead.`,
        );
      }
    }

    return mutate(chatId, async (store) => {
      let rec = store.files.find((f) => f.path === rel);
      const isNew = rec === undefined;
      if (!rec) {
        // First touch: capture the base from disk.
        let base: StoredFile;
        if (target.exists) {
          const info = await fs.stat(target.abs);
          if (!info.isFile()) throw badPath(`${rel} is not a regular file.`);
          const bytes = await fs.readFile(target.abs);
          const text = bytes.includes(0) ? null : decodeUtf8(bytes);
          if (text === null && content !== null) {
            throw new CoreError('unsupported_file', `${rel} is a binary file; it can't be edited or overwritten.`);
          }
          base = {
            path: rel,
            baseHash: sha256(bytes),
            baseContent: text ?? '',
            binary: text === null ? true : undefined,
            content: text,
            lastMessageId: messageId,
          };
        } else {
          if (content === null) throw new CoreError('not_found', `${rel} does not exist.`);
          base = { path: rel, baseHash: '', baseContent: null, content: null, lastMessageId: messageId };
        }
        rec = base;
      } else if (rec.binary && content !== null) {
        throw new CoreError('unsupported_file', `${rel} is a binary file; it can't be edited or overwritten.`);
      }

      // Keep a CRLF file CRLF when the model wrote plain LF.
      let next = content;
      if (next !== null && rec.baseContent && detectEol(rec.baseContent) === '\r\n' && !next.includes('\r')) {
        next = next.replace(/\n/g, '\r\n');
      }

      rec.content = next;
      rec.lastMessageId = messageId;

      const baseText = rec.baseContent;
      const noop =
        (baseText === null && next === null) ||
        (baseText !== null && next !== null && !rec.binary && sameLines(baseText, next));
      const others = store.files.filter((f) => f.path !== rel);

      if (noop) {
        store.files = others;
      } else {
        if (isNew && store.files.length >= LIMITS.pendingFilesPerChat) {
          throw new CoreError(
            'conflict',
            `Too many proposed files (limit ${LIMITS.pendingFilesPerChat}). Ask the user to review them first.`,
          );
        }
        store.files = [...others, rec];
      }

      if (!(noop && isNew)) {
        store.revision += 1;
        store.messageId = messageId;
      }
      const files = [...store.files].sort(byPath).map(fileChangeOf);
      return {
        file: noop ? null : (files.find((f) => f.path === rel) ?? null),
        summary: summaryOf(store, files),
      };
    });
  }

  // -------------------------------------------------------------------------------------------- apply

  async function checkConflict(
    projectRoot: string,
    rec: StoredFile,
    kind: ChangeKind,
  ): Promise<{ reason: ApplyConflictReason } | { abs: string; mode: number; root: string }> {
    const target = await resolveTarget(projectRoot, rec.path, deps.sandbox);
    if (!target.ok || target.rel !== rec.path) return { reason: 'blocked' };
    if (kind === 'create') {
      if (target.exists) return { reason: 'exists_on_disk' };
      return { abs: target.abs, mode: 0o644, root: target.root };
    }
    if (!target.exists) return { reason: 'deleted_on_disk' };
    const info = await fs.stat(target.abs);
    if (!info.isFile()) return { reason: 'changed_on_disk' };
    const bytes = await fs.readFile(target.abs);
    if (sha256(bytes) !== rec.baseHash) return { reason: 'changed_on_disk' };
    return { abs: target.abs, mode: info.mode & 0o7777, root: target.root };
  }

  async function apply(input: {
    chatId: Id;
    projectRoot: string;
    revision: number;
    decisions: Record<string, Record<string, HunkDecision>>;
  }): Promise<{ batch: AppliedBatch; changes: ChatChanges }> {
    return mutate(input.chatId, async (store) => {
      if (store.files.length === 0 || input.revision !== store.revision) throw new CoreError('changes_stale');

      const written: FileChange[] = [];
      const conflicts: AppliedBatch['conflicts'] = [];
      const ev = { written: [] as NoteFile[], rejected: [] as NoteFile[], skipped: [] as NoteFile[] };
      let rejectedHunks = 0;
      let skippedHunks = 0;

      for (const rec of [...store.files].sort(byPath)) {
        const change = fileChangeOf(rec);
        if (change.tooLarge) continue; // too big to review hunk by hunk; never written
        const decided = input.decisions[rec.path] ?? {};
        const accepted = change.hunks.filter((h) => decided[h.id] === 'accepted');
        const rejected = change.hunks.filter((h) => decided[h.id] === 'rejected').length;
        const undecided = change.hunks.length - accepted.length - rejected;
        const info: NoteFile = {
          path: rec.path,
          kind: change.kind,
          accepted: accepted.length,
          total: change.hunks.length,
        };

        if (accepted.length === 0) {
          rejectedHunks += rejected;
          skippedHunks += undecided;
          (rejected > 0 ? ev.rejected : ev.skipped).push(info);
          continue;
        }

        const check = await checkConflict(input.projectRoot, rec, change.kind);
        if ('reason' in check) {
          conflicts.push({ path: rec.path, reason: check.reason });
          continue;
        }
        rejectedHunks += rejected;
        skippedHunks += undecided;
        try {
          if (change.kind === 'delete') {
            await fs.unlink(check.abs);
          } else {
            await fs.mkdir(path.dirname(check.abs), { recursive: true });
            // Re-check after creating parents: nothing may have turned into a link on the way.
            const again = await resolveTarget(input.projectRoot, rec.path, deps.sandbox);
            if (!again.ok || again.rel !== rec.path) {
              conflicts.push({ path: rec.path, reason: 'blocked' });
              continue;
            }
            const text = applyHunks(rec.baseContent, rec.content, accepted);
            await writeFileAtomic(check.abs, text, check.mode);
          }
        } catch (err) {
          deps.logger?.warn(`apply: could not write ${rec.path}: ${String(err)}`);
          conflicts.push({ path: rec.path, reason: 'blocked' });
          continue;
        }
        written.push(
          accepted.length === change.hunks.length ? change : finishFileChange(change.path, change.kind, accepted),
        );
        ev.written.push(info);
      }

      const batch: AppliedBatch = {
        id: newId(),
        appliedAt: now().toISOString(),
        messageId: store.messageId,
        written,
        rejectedHunks,
        skippedHunks,
        conflicts,
      };
      store.events.push({ type: 'applied', ...ev, conflicts });
      if (written.length > 0 || conflicts.length > 0) {
        store.applied = [...store.applied, batch].slice(-MAX_APPLIED);
      }
      clearPending(store);
      return { batch, changes: chatChangesOf(store) };
    });
  }

  // -------------------------------------------------------------------------------------------- service

  return {
    get: async (chatId) => chatChangesOf(await load(chatId)),

    tools({ chatId, projectRoot, messageId }): ToolChanges {
      return {
        async read(relPath) {
          const target = await resolveTarget(projectRoot, relPath, deps.sandbox);
          // Not resolvable: let the read tool report the problem against the disk.
          const key = target.ok ? target.rel : null;
          if (key === null) return null;
          const rec = (await load(chatId)).files.find((f) => f.path === key);
          if (!rec) return null;
          return rec.content === null ? { kind: 'deleted' } : { kind: 'staged', content: rec.content };
        },
        async staged() {
          return (await load(chatId)).files.sort(byPath).map((f) => ({ path: f.path, kind: kindOf(f) }));
        },
        stage: (relPath, content) => stage(chatId, projectRoot, messageId, relPath, content),
      };
    },

    snapshot: (chatId, userMessageId) =>
      mutate(chatId, (store) => {
        const snap = {
          userMessageId,
          revision: store.revision,
          messageId: store.messageId,
          files: structuredClone(store.files),
        };
        store.snapshots = [...store.snapshots.filter((s) => s.userMessageId !== userMessageId), snap].slice(
          -MAX_SNAPSHOTS,
        );
      }),

    restore: (chatId, userMessageId) =>
      mutate(chatId, (store) => {
        const snap = store.snapshots.find((s) => s.userMessageId === userMessageId);
        if (!snap) return;
        store.files = structuredClone(snap.files);
        store.messageId = snap.messageId;
        store.revision += 1;
      }),

    takeNote: (chatId) =>
      mutate(chatId, (store) => {
        const note = buildNote(store.events as ChangeEvent[], store.files.length);
        store.events = [];
        return note;
      }),

    apply,

    discard: (chatId) =>
      mutate(chatId, (store) => {
        if (store.files.length > 0) {
          store.events.push({
            type: 'discarded',
            files: [...store.files].sort(byPath).map((f) => ({ path: f.path, kind: kindOf(f) })),
          });
          clearPending(store);
        }
        return chatChangesOf(store);
      }),

    removeForChat: async (chatId) => {
      await fileFor(chatId).delete();
    },
  };
}
