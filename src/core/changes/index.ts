// Change sets: per-chat proposals that the edit tools stage and the user applies (Review), and per-turn batches of
// what the model wrote straight to disk (Auto), with the original bytes Undo needs.

import { randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { EDIT_MODES, LIMITS } from '@shared/constants';
import type {
  AppliedBatch,
  ApplyConflictReason,
  BatchUndo,
  ChangeKind,
  ChangeSummary,
  ChatChanges,
  FileChange,
  HunkDecision,
  Id,
  PendingChanges,
  UndoSkipReason,
} from '@shared/types';
import { z } from 'zod';
import {
  autoPendingText,
  autoStaleText,
  autoUnreadText,
  autoWriteFailedText,
  modeChangedNote,
  tooLargeToReviewText,
  tooManyProposedText,
  undoneNote,
} from '../agent/edit-mode';
import { CoreError } from '../errors';
import { isNotFound, JsonFile, type StorageLogger, writeFileAtomic } from '../storage/json-file';
import { withFileLock } from '../storage/mutex';
import { type DataPaths, dataPaths } from '../storage/paths';
import { resolveInProject, type SandboxOptions, sameFoldedRel } from '../tools/sandbox';
import type { EditToolName, ToolChanges } from '../tools/types';
import type { ChangesService } from '../types';
import { type BlobStore, createBlobStore, sha256 } from './blobs';
import { applyHunks, detectEol, diffFile, finishFileChange, sameLines } from './diff';
import { buildNote, type ChangeEvent, type NoteFile } from './note';
import { withWriteLock } from './write-lock';

export { applyHunks, diffFile } from './diff';

// ---------------------------------------------------------------------------------------------------- storage
//
// `version` stays 1. Every field added for Auto is optional on read, so a store written by an older build loads as
// Review history (`source` missing = 'review', `diskSeq` missing = 0), and an older build rewriting a newer store
// strips them instead of quarantining it.

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
const conflictSchema = z.object({
  path: z.string(),
  reason: z.enum(['changed_on_disk', 'deleted_on_disk', 'exists_on_disk', 'blocked', 'too_large']),
});
const undoSkipSchema = z.object({ path: z.string(), reason: z.enum(['changed_since', 'blocked', 'unavailable']) });
const batchUndoSchema = z.object({
  at: z.string(),
  by: z.enum(['user', 'retry']),
  restored: z.array(z.string()),
  skipped: z.array(undoSkipSchema),
});
/** What Undo needs for one file of an auto batch. */
const undoEntrySchema = z.object({
  path: z.string(),
  /** The file before the turn's first write to it (its bytes are the blob `hash`); null = it did not exist. */
  before: z.object({ hash: z.string(), mode: z.number() }).nullable(),
  /** sha256 of what the turn left on disk; null = the turn deleted it. */
  afterHash: z.string().nullable(),
});
type UndoEntry = z.infer<typeof undoEntrySchema>;
const batchSchema = z.object({
  id: z.string(),
  appliedAt: z.string(),
  messageId: z.string(),
  written: z.array(fileChangeSchema),
  rejectedHunks: z.number(),
  skippedHunks: z.number(),
  conflicts: z.array(conflictSchema),
  /** Missing = 'review'. */
  source: z.enum(['review', 'auto']).optional(),
  /** Auto: the user message that started the turn. */
  turnId: z.string().optional(),
  /** Auto: the project the turn wrote into. Undo refuses any other project. */
  projectId: z.string().optional(),
  undo: batchUndoSchema.optional(),
  /** Auto, while undoable. Dropped (and its blobs collected) once undone or past retention. */
  undoData: z.array(undoEntrySchema).optional(),
});
type StoredBatch = z.infer<typeof batchSchema>;
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
    // Never holds a `too_large` conflict (those go to `tooLarge`), so an older build can still read the event.
    conflicts: z.array(conflictSchema),
    tooLarge: z.array(z.string()).optional(),
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
  /** Bumps whenever this chat changed project files. Missing = 0. */
  diskSeq: z.number().optional(),
  /** The edit mode of the last turn that took a note (or was retried). Missing = 'review'. */
  lastMode: z.enum(EDIT_MODES).optional().catch(undefined),
  /** User undos not yet reported in a note. A separate array (not an `events` type) so older builds strip it. */
  undone: z.array(z.object({ restored: z.array(z.string()), skipped: z.array(undoSkipSchema) })).optional(),
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
/** Batches kept in the list, review and auto alike. */
const MAX_APPLIED = 100;
/** Paths remembered per chat in the read record; the oldest are dropped first. */
const MAX_SEEN_PATHS = 1_000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const PLACEHOLDER = /«redacted:[^»]*»/;

// ---------------------------------------------------------------------------------------------------- helpers

export interface ChangesServiceDeps {
  /** Absolute data dir (the tree must exist; see `ensureDataDir`). */
  dataDir: string;
  /** Sandbox options for project paths (denied roots / files such as the app's data dir and `secrets.json`). */
  sandbox?: SandboxOptions;
  logger?: StorageLogger;
  /**
   * The chat's current project, so `get` marks an auto batch written into another project as not undoable. Omitted:
   * that part of `undoable` is skipped (`undoBatch` and `prepareRetry` still refuse another project).
   */
  chatProjectId?: (chatId: Id) => Promise<Id | null>;
  /** Test hooks. */
  now?: () => Date;
  newId?: () => string;
  /**
   * Test hook: runs inside the file's write lock, after the checks (and after creating parent folders), right before
   * the file is re-resolved and written or deleted. Awaiting in it holds the lock, which makes races deterministic.
   * A throw counts as a failed write.
   */
  beforeWrite?: (info: { op: 'auto' | 'apply' | 'undo'; chatId: Id; path: string }) => Promise<void> | void;
}

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

/**
 * The chat's project as far as `undoable` is concerned: an id, null (no project: nothing is undoable), or undefined
 * (unknown: the project part of the check is skipped).
 */
type ProjectCheck = Id | null | undefined;

/** The API shape of a stored batch: `undoData` and `projectId` are never sent. */
function batchOf(b: StoredBatch, project: ProjectCheck): AppliedBatch {
  const { source = 'review', turnId, projectId, undo, undoData, ...rest } = b;
  const undoable =
    source === 'auto' &&
    undo === undefined &&
    undoData !== undefined &&
    (project === undefined || (project !== null && projectId === project));
  return {
    ...rest,
    source,
    ...(turnId !== undefined ? { turnId } : {}),
    undoable,
    ...(undo !== undefined ? { undo } : {}),
  };
}

const chatChangesOf = (store: Store, project: ProjectCheck): ChatChanges => ({
  pending: pendingOf(store),
  applied: store.applied.map((b) => batchOf(b, project)),
  diskSeq: store.diskSeq ?? 0,
});

function decodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** The text of a file's bytes, or null for a binary file. */
const textOf = (bytes: Buffer): string | null => (bytes.includes(0) ? null : decodeUtf8(bytes));

/** Throws when `content` can't be written: too big, not plain UTF-8 text, or holding a redaction placeholder. */
function validateContent(rel: string, content: string): void {
  if (Buffer.byteLength(content) > LIMITS.writeFileMaxBytes) {
    throw new CoreError('file_too_large', `The new content of ${rel} is over ${LIMITS.writeFileMaxBytes / 1024} KB.`);
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

/** Keeps a CRLF file CRLF when the model wrote plain LF. */
function keepCrlf(base: string | null, next: string | null): string | null {
  if (next !== null && base && detectEol(base) === '\r\n' && !next.includes('\r')) return next.replace(/\n/g, '\r\n');
  return next;
}

const binaryText = (rel: string) => `${rel} is a binary file; it can't be edited or overwritten.`;

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
      // Still rejected; the message only names the canonical spelling when the two differ by case or Unicode form.
      const respelled = info !== null && !info.isSymbolicLink() && sameFoldedRel(lexical, res.rel);
      const message = respelled
        ? `Path differs from its on-disk spelling "${res.rel}" (letter case or Unicode form) or goes through a symbolic link`
        : 'Path goes through a symbolic link';
      return { ok: false, kind: 'link', message };
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
const targetError = (target: Extract<Target, { ok: false }>, relPath: string) =>
  badPath(target.kind === 'link' ? `${target.message}: ${relPath}` : target.message);

/** A project file as it is on disk right now. `lstat`, so a symlink shows up as `other`. */
type OnDisk =
  | { kind: 'missing' }
  | { kind: 'other' }
  | { kind: 'file'; bytes: Buffer; hash: string; mode: number; text: string | null };

async function readOnDisk(abs: string): Promise<OnDisk> {
  let info: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    info = await fs.lstat(abs);
  } catch (err) {
    if (isNotFound(err)) return { kind: 'missing' };
    throw err;
  }
  if (!info.isFile()) return { kind: 'other' };
  const bytes = await fs.readFile(abs);
  return { kind: 'file', bytes, hash: sha256(bytes), mode: info.mode & 0o7777, text: textOf(bytes) };
}

/**
 * Atomic write that also restores `mode`'s permission bits, which `open` masks with the umask. The fix-up opens the
 * path without following a link, so a path swapped for a symlink is never chmod-ed through. It is best effort: once
 * the rename has happened the content is on disk, so a failed fix-up must not report the write as failed.
 */
async function writeWithMode(
  abs: string,
  data: string | Uint8Array,
  mode: number,
  logger: StorageLogger | undefined,
): Promise<void> {
  await writeFileAtomic(abs, data, mode);
  const bits = mode & 0o777;
  try {
    const handle = await fs.open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      if (((await handle.stat()).mode & 0o777) !== bits) await handle.chmod(bits);
    } finally {
      await handle.close();
    }
  } catch (err) {
    logger?.warn(`could not set the permissions of ${path.basename(abs)}: ${String(err)}`);
  }
}

/** Every blob hash a batch of the store still needs. */
function referencedBlobs(store: Store): Set<string> {
  const keep = new Set<string>();
  for (const b of store.applied) for (const e of b.undoData ?? []) if (e.before) keep.add(e.before.hash);
  return keep;
}

/** Drops the undo data of every auto batch older than the newest `LIMITS.autoUndoTurns` auto batches. */
function applyRetention(store: Store): void {
  const autos = store.applied.filter((b) => b.source === 'auto');
  for (const b of autos.slice(0, Math.max(0, autos.length - LIMITS.autoUndoTurns))) delete b.undoData;
}

// ---------------------------------------------------------------------------------------------------- service

export function createChangesService(deps: ChangesServiceDeps): ChangesService {
  const paths: DataPaths = dataPaths(deps.dataDir);
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  /**
   * What each chat has seen of each file: path → sha256 of the bytes `read_file` last returned from disk, or of what
   * the chat itself last wrote. In memory only (empty after a restart, so the model reads again), recorded in both
   * modes, enforced in Auto. Map order is insertion order, so the first key is the oldest.
   */
  const seen = new Map<Id, Map<string, string>>();

  function remember(chatId: Id, rel: string, hash: string): void {
    let record = seen.get(chatId);
    if (!record) {
      record = new Map();
      seen.set(chatId, record);
    }
    record.delete(rel);
    record.set(rel, hash);
    while (record.size > MAX_SEEN_PATHS) {
      const oldest = record.keys().next().value;
      if (oldest === undefined) break;
      record.delete(oldest);
    }
  }

  const forget = (chatId: Id, rel: string): void => {
    seen.get(chatId)?.delete(rel);
  };

  const fileFor = (chatId: Id): JsonFile<Store> => {
    if (!SAFE_ID.test(chatId)) throw new CoreError('not_found', 'Chat not found.');
    return new JsonFile<Store>(paths.changesFile(chatId), storeSchema, { logger: deps.logger });
  };

  /** Only use under the chat's store lock (see `BlobStore`). `fileFor` has already vetted the id. */
  const blobsFor = (chatId: Id): BlobStore => createBlobStore(paths.changesBlobDir(chatId));

  /**
   * Read-modify-write under the chat's store lock. `fn` must not call `load` or `mutate` (the lock isn't re-entrant).
   * LOCK ORDER: this store lock is taken first; inside `fn`, at most one project-file write lock at a time
   * (`withWriteLock`), never another chat's store lock. A throw leaves the stored file unchanged.
   */
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

  async function chatProject(chatId: Id): Promise<ProjectCheck> {
    if (!deps.chatProjectId) return undefined;
    return deps.chatProjectId(chatId).catch(() => null);
  }

  function clearPending(store: Store): void {
    store.files = [];
    store.revision += 1;
  }

  /** Deletes the blobs no batch references any more. Under the store lock only. */
  const collectBlobs = (chatId: Id, store: Store): Promise<void> =>
    blobsFor(chatId)
      .collect(referencedBlobs(store))
      .catch((err) => deps.logger?.warn(`changes: could not clean up stored originals: ${String(err)}`));

  // -------------------------------------------------------------------------------------------- staging (Review)

  async function stage(
    chatId: Id,
    projectRoot: string,
    messageId: Id,
    relPath: string,
    content: string | null,
  ): Promise<{ file: FileChange | null; summary: ChangeSummary | null }> {
    const target = await resolveTarget(projectRoot, relPath, deps.sandbox);
    if (!target.ok) throw targetError(target, relPath);
    const rel = target.rel;

    if (content !== null) validateContent(rel, content);

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
          const text = textOf(bytes);
          if (text === null && content !== null) throw new CoreError('unsupported_file', binaryText(rel));
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
        throw new CoreError('unsupported_file', binaryText(rel));
      }

      const next = keepCrlf(rec.baseContent, content);

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
          throw new CoreError('conflict', tooManyProposedText(LIMITS.pendingFilesPerChat));
        }
        store.files = [...others, rec];
      }

      if (!(noop && isNew)) {
        store.revision += 1;
        store.messageId = messageId;
      }
      const files = [...store.files].sort(byPath).map(fileChangeOf);
      const file = noop ? null : (files.find((f) => f.path === rel) ?? null);
      // A diff too large to review hunk by hunk could never be applied; refuse it now so the model hears why. The
      // throw leaves the stored set as it was.
      if (file?.tooLarge) throw new CoreError('invalid_request', tooLargeToReviewText(rel));
      return { file, summary: summaryOf(store, files) };
    });
  }

  // -------------------------------------------------------------------------------------------- writing (Auto)

  async function autoWrite(
    turn: { chatId: Id; projectId: Id; projectRoot: string; messageId: Id; turnId: Id },
    relPath: string,
    content: string | null,
    opts: { tool: EditToolName; baseHash: string },
  ): Promise<{ file: FileChange | null; batchId: Id | null }> {
    const { chatId, projectId, projectRoot } = turn;
    if (content !== null) validateContent(relPath, content);
    const target = await resolveTarget(projectRoot, relPath, deps.sandbox);
    if (!target.ok) throw targetError(target, relPath);
    const rel = target.rel;

    return mutate(chatId, async (store) => {
      // Writing over a pending proposal would make its review meaningless; the pending set stays untouched. Compared
      // case- and Unicode-folded: a spelling that might be the same file on this disk is refused too.
      if (store.files.some((f) => sameFoldedRel(f.path, rel))) throw new CoreError('conflict', autoPendingText(rel));

      const blobs = blobsFor(chatId);
      // LOCK ORDER: the chat's store lock (held by `mutate`), then this one file's write lock. No other lock inside.
      return withWriteLock(target.abs, async () => {
        const disk = await readOnDisk(target.abs).catch((err) => {
          deps.logger?.warn(`auto write: could not read ${rel}: ${String(err)}`);
          throw new CoreError('internal', autoWriteFailedText(rel));
        });
        if (disk.kind === 'other') throw badPath(`${rel} is not a regular file.`);
        const current = disk.kind === 'file' ? disk : null;
        const currentHash = current?.hash ?? '';

        // Race check: the tool built the change from these exact bytes (or from "missing").
        if (currentHash !== opts.baseHash) throw new CoreError('conflict', autoStaleText(rel));
        // Stale-read guard: never overwrite bytes this chat hasn't seen. `edit_file` may go without a read, since its
        // old_string must match the current text exactly; replacing or deleting a whole file needs one.
        if (current) {
          const seenHash = seen.get(chatId)?.get(rel);
          if (seenHash === undefined && opts.tool !== 'edit_file') {
            throw new CoreError('conflict', autoUnreadText(rel));
          }
          if (seenHash !== undefined && seenHash !== currentHash) throw new CoreError('conflict', autoStaleText(rel));
          if (current.text === null && content !== null) throw new CoreError('unsupported_file', binaryText(rel));
        } else if (content === null) {
          throw new CoreError('not_found', `${rel} does not exist.`);
        }

        const next = keepCrlf(current?.text ?? null, content);
        const nextBytes = next === null ? null : Buffer.from(next, 'utf8');
        if (current && nextBytes?.equals(current.bytes)) return { file: null, batchId: null };

        // The turn's open batch, or a new one. Nothing is stored until the write has succeeded.
        const open = store.applied.find(
          (b) => b.source === 'auto' && b.turnId === turn.turnId && !b.undo && b.undoData !== undefined,
        );
        const batch: StoredBatch = open ?? {
          id: newId(),
          appliedAt: '',
          messageId: turn.messageId,
          written: [],
          rejectedHunks: 0,
          skippedHunks: 0,
          conflicts: [],
          source: 'auto',
          turnId: turn.turnId,
          projectId,
          undoData: [],
        };
        const undoData = batch.undoData ?? [];
        let entry = undoData.find((e) => e.path === rel);
        try {
          // First touch of this file in the turn: keep its original before anything changes on disk.
          if (!entry) {
            entry = {
              path: rel,
              before: current ? { hash: await blobs.put(current.bytes), mode: current.mode } : null,
              afterHash: null,
            };
          }

          if (next !== null) await fs.mkdir(path.dirname(target.abs), { recursive: true });
          await deps.beforeWrite?.({ op: 'auto', chatId, path: rel });
          // Re-check after creating parents: nothing may have turned into a link on the way.
          const again = await resolveTarget(projectRoot, rel, deps.sandbox);
          if (!again.ok || again.rel !== rel) {
            throw badPath(again.ok ? `Path goes through a symbolic link: ${rel}` : `${again.message}: ${rel}`);
          }
          if (nextBytes === null) await fs.unlink(target.abs);
          else await writeWithMode(target.abs, nextBytes, current?.mode ?? 0o644, deps.logger);
        } catch (err) {
          // The store is unchanged; drop a blob that only this failed write referenced.
          await collectBlobs(chatId, store);
          if (err instanceof CoreError) throw err;
          deps.logger?.warn(`auto write: could not write ${rel}: ${String(err)}`);
          throw new CoreError('internal', autoWriteFailedText(rel));
        }

        // Record: the file's diff from before the turn to now, and what Undo will compare against.
        const afterHash = nextBytes === null ? null : sha256(nextBytes);
        entry.afterHash = afterHash;
        // A binary original diffs as empty, as in a review proposal.
        let beforeContent: string | null = null;
        if (entry.before) {
          const bytes =
            current && entry.before.hash === current.hash ? current.bytes : await blobs.get(entry.before.hash);
          beforeContent = bytes ? (textOf(bytes) ?? '') : '';
        }
        const others = batch.written.filter((f) => f.path !== rel);
        const otherEntries = undoData.filter((e) => e.path !== rel);
        if (afterHash === (entry.before?.hash ?? null)) {
          // Back to where the turn started: nothing of this file to show or undo.
          batch.written = others;
          batch.undoData = otherEntries;
        } else {
          batch.written = [...others, diffFile(rel, beforeContent, next)].sort(byPath);
          batch.undoData = [...otherEntries, entry].sort(byPath);
        }
        batch.appliedAt = now().toISOString();

        if (!open) {
          store.applied.push(batch);
          applyRetention(store);
        }
        // An auto batch with no file left (a file created and deleted again) has nothing to show or undo.
        if (batch.written.length === 0) store.applied = store.applied.filter((b) => b !== batch);
        store.applied = store.applied.slice(-MAX_APPLIED);
        store.diskSeq = (store.diskSeq ?? 0) + 1;
        if (afterHash === null) forget(chatId, rel);
        else remember(chatId, rel, afterHash);
        await collectBlobs(chatId, store);

        const base = current ? (current.text ?? '') : null;
        return { file: diffFile(rel, base, next), batchId: batch.id };
      });
    });
  }

  // -------------------------------------------------------------------------------------------- undo (Auto)

  /**
   * Puts one file back as it was before the turn, if it is still exactly what the turn left. Returns why it was
   * skipped, or null when restored. Called under the chat's store lock; takes the file's write lock itself.
   */
  async function undoFile(
    chatId: Id,
    projectRoot: string,
    e: UndoEntry,
    blobs: BlobStore,
  ): Promise<UndoSkipReason | null> {
    const target = await resolveTarget(projectRoot, e.path, deps.sandbox);
    if (!target.ok || target.rel !== e.path) return 'blocked';
    // LOCK ORDER: the chat's store lock (held by the caller's `mutate`), then this one file's write lock.
    return withWriteLock(target.abs, async () => {
      // Never touch a file that changed after the turn: Undo must not destroy later work.
      const disk = await readOnDisk(target.abs).catch(() => null);
      if (disk === null) return 'blocked';
      const untouched =
        e.afterHash === null ? disk.kind === 'missing' : disk.kind === 'file' && disk.hash === e.afterHash;
      if (!untouched) return 'changed_since';
      let original: Buffer | null = null;
      if (e.before) {
        original = await blobs.get(e.before.hash);
        if (original === null) return 'unavailable';
      }
      try {
        if (original) await fs.mkdir(path.dirname(target.abs), { recursive: true });
        await deps.beforeWrite?.({ op: 'undo', chatId, path: e.path });
        const again = await resolveTarget(projectRoot, e.path, deps.sandbox);
        if (!again.ok || again.rel !== e.path) return 'blocked';
        if (original === null || e.before === null) await fs.unlink(target.abs);
        else await writeWithMode(target.abs, original, e.before.mode, deps.logger);
      } catch (err) {
        deps.logger?.warn(`undo: could not restore ${e.path}: ${String(err)}`);
        return 'blocked';
      }
      return null;
    });
  }

  /** Undoes one batch in place (it must still have its undo data). Under the chat's store lock only. */
  async function undoInStore(
    chatId: Id,
    projectRoot: string,
    store: Store,
    batch: StoredBatch,
    by: BatchUndo['by'],
  ): Promise<BatchUndo> {
    const blobs = blobsFor(chatId);
    const restored: string[] = [];
    const skipped: BatchUndo['skipped'] = [];
    for (const e of [...(batch.undoData ?? [])].sort(byPath)) {
      const reason = await undoFile(chatId, projectRoot, e, blobs);
      if (reason) skipped.push({ path: e.path, reason });
      else restored.push(e.path);
    }
    const undo: BatchUndo = { at: now().toISOString(), by, restored, skipped };
    batch.undo = undo;
    delete batch.undoData;
    if (restored.length > 0) store.diskSeq = (store.diskSeq ?? 0) + 1;
    for (const p of restored) forget(chatId, p);
    // A user's undo goes into the next note; a retry's doesn't (the retried message's note says it instead).
    if (by === 'user') store.undone = [...(store.undone ?? []), { restored, skipped }];
    await collectBlobs(chatId, store);
    return undo;
  }

  const notUndoable = () => new CoreError('conflict', 'These edits can no longer be undone.');

  // -------------------------------------------------------------------------------------------- apply (Review)

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
    const project = await chatProject(input.chatId);
    return mutate(input.chatId, async (store) => {
      if (store.files.length === 0 || input.revision !== store.revision) throw new CoreError('changes_stale');

      const written: FileChange[] = [];
      const conflicts: AppliedBatch['conflicts'] = [];
      const tooLarge: string[] = [];
      const ev = { written: [] as NoteFile[], rejected: [] as NoteFile[], skipped: [] as NoteFile[] };
      let rejectedHunks = 0;
      let skippedHunks = 0;

      for (const rec of [...store.files].sort(byPath)) {
        const change = fileChangeOf(rec);
        if (change.tooLarge) {
          // Too big to review hunk by hunk (left by an older build): never written, and reported.
          conflicts.push({ path: rec.path, reason: 'too_large' });
          tooLarge.push(rec.path);
          continue;
        }
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

        const target = await resolveTarget(input.projectRoot, rec.path, deps.sandbox);
        if (!target.ok || target.rel !== rec.path) {
          conflicts.push({ path: rec.path, reason: 'blocked' });
          continue;
        }
        // LOCK ORDER: the chat's store lock (held by `mutate`), then this one file's write lock, released before the
        // next file. The hash check and the write happen under it, so an auto write in another chat can't slip in.
        const outcome = await withWriteLock(target.abs, async (): Promise<ApplyConflictReason | null> => {
          const check = await checkConflict(input.projectRoot, rec, change.kind);
          if ('reason' in check) return check.reason;
          rejectedHunks += rejected;
          skippedHunks += undecided;
          try {
            if (change.kind === 'delete') {
              await deps.beforeWrite?.({ op: 'apply', chatId: input.chatId, path: rec.path });
              await fs.unlink(check.abs);
            } else {
              await fs.mkdir(path.dirname(check.abs), { recursive: true });
              await deps.beforeWrite?.({ op: 'apply', chatId: input.chatId, path: rec.path });
              // Re-check after creating parents: nothing may have turned into a link on the way.
              const again = await resolveTarget(input.projectRoot, rec.path, deps.sandbox);
              if (!again.ok || again.rel !== rec.path) return 'blocked';
              const text = applyHunks(rec.baseContent, rec.content, accepted);
              await writeFileAtomic(check.abs, text, check.mode);
            }
          } catch (err) {
            deps.logger?.warn(`apply: could not write ${rec.path}: ${String(err)}`);
            return 'blocked';
          }
          return null;
        });
        if (outcome !== null) {
          conflicts.push({ path: rec.path, reason: outcome });
          continue;
        }
        written.push(
          accepted.length === change.hunks.length ? change : finishFileChange(change.path, change.kind, accepted),
        );
        ev.written.push(info);
      }

      const batch: StoredBatch = {
        id: newId(),
        appliedAt: now().toISOString(),
        messageId: store.messageId,
        written,
        rejectedHunks,
        skippedHunks,
        conflicts,
        source: 'review',
      };
      store.events.push({
        type: 'applied',
        ...ev,
        conflicts: conflicts.filter((c) => c.reason !== 'too_large'),
        ...(tooLarge.length > 0 ? { tooLarge } : {}),
      });
      if (written.length > 0 || conflicts.length > 0) {
        store.applied = [...store.applied, batch].slice(-MAX_APPLIED);
        // Auto batches may have dropped off the list: their originals are no longer needed.
        await collectBlobs(input.chatId, store);
      }
      if (written.length > 0) store.diskSeq = (store.diskSeq ?? 0) + 1;
      clearPending(store);
      return { batch: batchOf(batch, project), changes: chatChangesOf(store, project) };
    });
  }

  // -------------------------------------------------------------------------------------------- service

  return {
    get: async (chatId) => {
      const project = await chatProject(chatId);
      return chatChangesOf(await load(chatId), project);
    },

    tools({ chatId, projectId, projectRoot, messageId, turnId, mode }): ToolChanges {
      return {
        mode,
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
        async stage(relPath, content) {
          if (mode !== 'review') throw new Error('stage() is for Review turns; this turn is in Auto.');
          return stage(chatId, projectRoot, messageId, relPath, content);
        },
        async write(relPath, content, opts) {
          if (mode !== 'auto') throw new Error('write() is for Auto turns; this turn is in Review.');
          return autoWrite({ chatId, projectId, projectRoot, messageId, turnId }, relPath, content, opts);
        },
        noteRead(relPath, bytes) {
          remember(chatId, relPath, sha256(bytes));
        },
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

    takeNote: (chatId, { mode, firstTurn }) =>
      mutate(chatId, (store) => {
        // Blocks in a fixed order: mode change, review outcome, user undos.
        const blocks: string[] = [];
        if (!firstTurn && mode !== (store.lastMode ?? 'review')) blocks.push(modeChangedNote(mode));
        const review = buildNote(store.events as ChangeEvent[], store.files.length);
        if (review) blocks.push(review);
        if (store.undone && store.undone.length > 0) blocks.push(undoneNote(store.undone));
        store.lastMode = mode;
        store.events = [];
        delete store.undone;
        return blocks.length > 0 ? blocks.join('\n\n') : undefined;
      }),

    apply,

    discard: async (chatId) => {
      const project = await chatProject(chatId);
      return mutate(chatId, (store) => {
        if (store.files.length > 0) {
          store.events.push({
            type: 'discarded',
            files: [...store.files].sort(byPath).map((f) => ({ path: f.path, kind: kindOf(f) })),
          });
          clearPending(store);
        }
        return chatChangesOf(store, project);
      });
    },

    undoBatch: ({ chatId, projectId, projectRoot, batchId }) =>
      mutate(chatId, async (store) => {
        const batch = store.applied.find((b) => b.id === batchId);
        // Throwing before any change also keeps an unknown chat from getting an empty store file.
        if (!batch) throw new CoreError('not_found', 'These edits were not found.');
        if (batch.source !== 'auto' || batch.undo || !batch.undoData || batch.projectId !== projectId) {
          throw notUndoable();
        }
        await undoInStore(chatId, projectRoot, store, batch, 'user');
        return { batch: batchOf(batch, projectId), changes: chatChangesOf(store, projectId) };
      }),

    prepareRetry: ({ chatId, projectId, projectRoot, turnId, mode }) =>
      mutate(chatId, async (store) => {
        store.lastMode = mode;
        // Batches past retention or written into another project can't be undone; they are left as they are.
        const batches = store.applied.filter(
          (b) =>
            b.source === 'auto' &&
            b.turnId === turnId &&
            !b.undo &&
            b.undoData !== undefined &&
            b.projectId === projectId,
        );
        let result: { batchId: Id; undo: BatchUndo } | null = null;
        for (const batch of batches) {
          const undo = await undoInStore(chatId, projectRoot, store, batch, 'retry');
          result = {
            batchId: batch.id,
            undo: result
              ? {
                  ...undo,
                  restored: [...result.undo.restored, ...undo.restored].sort(),
                  skipped: [...result.undo.skipped, ...undo.skipped].sort(byPath),
                }
              : undo,
          };
        }
        // The retry starts over: the model must read again before overwriting anything.
        seen.delete(chatId);
        return result;
      }),

    removeForChat: async (chatId) => {
      const file = fileFor(chatId);
      seen.delete(chatId);
      // Under the store lock (the `JsonFile` lock is keyed by the file's path), so no write of this chat can add a
      // blob while its folder goes.
      await withFileLock(file.path, async () => {
        await fs.unlink(file.path).catch((err) => {
          if (!isNotFound(err)) throw err;
        });
        await blobsFor(chatId).removeAll();
      });
    },
  };
}
