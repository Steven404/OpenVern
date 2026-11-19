// Change sets: per-chat proposals that the edit tools stage and the user applies (Review), and per-turn batches of
// what the model wrote straight to disk (Auto), with the original bytes Undo needs.

import { randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { APPLY_PROJECT_CHANGED, CHAT_HAS_NO_PROJECT, PROPOSALS_OTHER_PROJECT } from '@shared/api';
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
  autoSourceTooLargeText,
  autoStaleText,
  autoUnreadText,
  autoWriteFailedText,
  binaryTargetText,
  modeChangedNote,
  newContentTooLargeText,
  notUtf8Text,
  OTHER_PROJECT_PENDING_TEXT,
  placeholderContentText,
  tooLargeToReviewText,
  tooManyProposedText,
  undoneNote,
  writtenTooLargeText,
} from '../agent/edit-mode';
import { CoreError } from '../errors';
import { consoleLogger, isNotFound, type StorageLogger, writeFileAtomic } from '../storage/json-file';
import { withFileLock } from '../storage/mutex';
import { type DataPaths, dataPaths } from '../storage/paths';
import { resolveInProject, type SandboxOptions, sameFoldedRel } from '../tools/sandbox';
import type { EditToolName } from '../tools/types';
import type { ChangesService, TurnChanges } from '../types';
import { type BlobStore, createBlobStore, sha256 } from './blobs';
import { applyHunks, detectEol, diffFile, finishFileChange, sameLines } from './diff';
import { buildNote, type ChangeEvent, type NoteFile } from './note';
import { folderCheck, readAtMost, readNoFollow, UnsafeStorageError } from './storage-trust';
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
  /**
   * Auto: set when the chat's project changed after this batch's last write (`changeProject`). No later write joins
   * it; Undo is unaffected. Never sent.
   */
  closed: z.literal(true).optional(),
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
  /**
   * The project the snapshot's files were made for: the set's `pendingProjectId`, or for an unbound set the chat's
   * project when the snapshot was taken. Missing on a non-empty snapshot (an older build's, or one whose project
   * couldn't be read) = unknown: `restore` binds it to `UNKNOWN_PROJECT`.
   */
  projectId: z.string().optional(),
});
const storeSchema = z.object({
  version: z.literal(1),
  revision: z.number(),
  messageId: z.string(),
  files: z.array(storedFileSchema),
  /**
   * The project the pending proposals were made for: set by the stage that starts a pending set, dropped when the set
   * empties. Missing on a non-empty set (an older build's store) = unbound, which `apply` treats as the chat's current
   * project, as older builds did. `UNKNOWN_PROJECT` = made for a project that can't be known any more.
   */
  pendingProjectId: z.string().optional(),
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
/**
 * The `pendingProjectId` of proposals whose project can't be known: a retry restored a non-empty snapshot that names
 * no project. No project has this id (ids are never empty), so `apply` and `stage` always refuse such a set as made
 * for another project, while `discard` clears it. Binding it to the chat's project at restore time instead could
 * write the proposals into a project they were never made for.
 */
const UNKNOWN_PROJECT = '';
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
  /** Test hook: runs under the chat's store lock right before its store file is written. A throw fails that save. */
  beforeStoreWrite?: (info: { chatId: Id }) => Promise<void> | void;
}

const byPath = <T extends { path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * SPELLINGS OF ONE FILE ARE UNDONE TOGETHER OR NOT AT ALL (invariant): Undo entries are keyed by exact path, but a turn
 * can reach one file under two spellings (the user renames `a.txt` to `A.txt` while the reply runs, and the reply then
 * rewrites `A.txt`). Each entry expects the bytes its own write left, so handling the spellings one by one can skip one
 * and still act on the other: once the user renames the file back and restores the first write's bytes, the `A.txt`
 * entry is skipped and the `a.txt` entry (a create) deletes the user's file. So the paths that share a fold with
 * another, different path in the same undo are returned here, and every one of them is skipped as `blocked` before
 * anything touches the disk. The fold is the sandbox's
 * (`sameFoldedRel`, as the write lock uses): it over-groups look-alikes the volume keeps apart, and on a case-sensitive
 * volume it groups names that are distinct files. Over-grouping only makes Undo more conservative (those files keep
 * the turn's edits and are reported), never destructive. A path with no other spelling is undone as usual.
 */
export function respelledPaths(paths: Iterable<string>, platform: NodeJS.Platform = process.platform): Set<string> {
  const unique = [...new Set(paths)];
  const out = new Set<string>();
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i] as string;
      const b = unique[j] as string;
      if (sameFoldedRel(a, b, platform)) {
        out.add(a);
        out.add(b);
      }
    }
  }
  return out;
}

/** The held reason for `p`: its own, or that of any held spelling of the same file (see `respelledPaths`). */
function heldReason(held: ReadonlyMap<string, UndoSkipReason> | undefined, p: string): UndoSkipReason | undefined {
  if (!held) return undefined;
  const own = held.get(p);
  if (own) return own;
  for (const [k, reason] of held) if (sameFoldedRel(k, p)) return reason;
  return undefined;
}

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

/** The API shape of a stored batch: `undoData`, `projectId` and `closed` are never sent. */
function batchOf(b: StoredBatch, project: ProjectCheck): AppliedBatch {
  const { source = 'review', turnId, projectId, undo, undoData, closed: _closed, ...rest } = b;
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
  // A cheap early bound on the content as sent; the final bytes (CRLF kept) are checked again before any write.
  if (Buffer.byteLength(content) > LIMITS.writeFileMaxBytes) {
    throw new CoreError('file_too_large', newContentTooLargeText(rel));
  }
  if (
    content.includes('\0') ||
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(content)
  ) {
    throw new CoreError('unsupported_file', notUtf8Text(rel));
  }
  if (PLACEHOLDER.test(content)) throw new CoreError('invalid_request', placeholderContentText(rel));
}

/** Keeps a CRLF file CRLF when the model wrote plain LF. */
function keepCrlf(base: string | null, next: string | null): string | null {
  if (next !== null && base && detectEol(base) === '\r\n' && !next.includes('\r')) return next.replace(/\n/g, '\r\n');
  return next;
}

const unsafeStoreText =
  "This chat's change history can't be opened safely: a folder or file in the app's data folder is a symbolic link or not a regular file. Nothing was read or changed.";

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

/**
 * PINNED ROOT (invariant): every mutation of a project file is pinned to the project's real root and the file's
 * absolute path as first resolved for the operation (one auto write, one review apply, one undo). The relative path
 * alone doesn't name the same file once the project folder (or a folder above it) has been renamed and a link to
 * another folder put in its place: it resolves cleanly there, maybe to identical bytes. So each later resolution,
 * the last check before the unlink or rename included, must give the same root and the same absolute path; anything
 * else refuses the file (`path_invalid` for Auto, `blocked` for apply and undo).
 */
interface Pin {
  root: string;
  abs: string;
}

const samePlace = (t: Extract<Target, { ok: true }>, pin: Pin): boolean => t.root === pin.root && t.abs === pin.abs;

/** The project's real root at the start of an apply or undo, or null when it can't be resolved (every file blocked). */
const pinRoot = (projectRoot: string): Promise<string | null> => fs.realpath(projectRoot).catch(() => null);

const movedText = (rel: string) => `The project folder was moved or replaced during the write: ${rel}`;

/**
 * A project file as it is on disk right now. `lstat`, so a symlink shows up as `other`. A file over
 * `LIMITS.editSourceMaxBytes` is `tooLarge` and its bytes are never read: Auto never loads, hashes or keeps a copy of
 * a file the edit tools wouldn't load either.
 */
type OnDisk =
  | { kind: 'missing' }
  | { kind: 'other' }
  | { kind: 'tooLarge' }
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
  if (info.size > LIMITS.editSourceMaxBytes) return { kind: 'tooLarge' };
  // Opened without following a link and without blocking on a FIFO, in case the path changed since the `lstat`; the
  // read is bounded too, in case the file grew.
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (isNotFound(err)) return { kind: 'missing' };
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') return { kind: 'other' };
    throw err;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { kind: 'other' };
    const bytes = await readAtMost(handle, LIMITS.editSourceMaxBytes);
    if (bytes === null) return { kind: 'tooLarge' };
    return { kind: 'file', bytes, hash: sha256(bytes), mode: opened.mode & 0o7777, text: textOf(bytes) };
  } finally {
    await handle.close();
  }
}

/** What a hash check compares: the file's sha256, `''` when missing, null when it can't match anything. */
const hashOnDisk = (d: OnDisk): string | null => (d.kind === 'file' ? d.hash : d.kind === 'missing' ? '' : null);

/**
 * The only way the change service changes a project file: `data === null` unlinks `abs`, anything else replaces it
 * atomically (temp file + rename). With `exactMode`, the permission bits are then set to `mode` exactly, since `open`
 * masks them with the umask; the fix-up opens the path without following a link and is best effort (once the rename
 * has happened the content is on disk, so a failed fix-up must not report the write as failed).
 *
 * RECHECK IMMEDIATELY BEFORE MUTATION (invariant): `check` re-resolves the path (it must still give the pinned root
 * and absolute path; see PINNED ROOT) and re-reads the file, and it is the last step before the unlink or the rename,
 * after every await that could let something change the file (blob writes, folder creation, the test hook, writing
 * the temp file). A non-null result refuses: nothing is changed and the result is returned. For a write it also runs
 * before the temp file is created, so a folder already swapped for a link gets no temp file (one swapped in the moment
 * between gets only that temp file, which the late check removes).
 * What remains is the race against other programs between `check`'s read and the unlink/rename syscall: a few
 * milliseconds, unavoidable because editors and shells take no lock we could share.
 */
async function replaceChecked<R>(
  abs: string,
  data: string | Uint8Array | null,
  mode: number,
  check: () => Promise<R | null>,
  opts: { exactMode: boolean; logger: StorageLogger | undefined },
): Promise<R | null> {
  const early = await check();
  if (early !== null) return early;
  if (data === null) {
    await fs.unlink(abs);
    return null;
  }
  // Same temp name as `writeFileAtomic`, so a leftover is recognisable.
  const tmp = `${abs}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const handle = await fs.open(tmp, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const late = await check();
    if (late !== null) {
      await fs.rm(tmp, { force: true });
      return late;
    }
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  if (opts.exactMode) {
    const bits = mode & 0o777;
    try {
      const handle = await fs.open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        if (((await handle.stat()).mode & 0o777) !== bits) await handle.chmod(bits);
      } finally {
        await handle.close();
      }
    } catch (err) {
      opts.logger?.warn(`could not set the permissions of ${path.basename(abs)}: ${String(err)}`);
    }
  }
  return null;
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
   * What each chat has seen of each file, per project: (project, path) → sha256 of the bytes `read_file` last returned
   * from disk, or of what the chat itself last wrote. In memory only (empty after a restart, so the model reads
   * again), recorded in both modes, enforced in Auto. Map order is insertion order, so the first key is the oldest.
   * READS STAY IN THEIR PROJECT (invariant): a record is made and checked with the turn's pinned project, so a read in
   * one project never lets a write through in another, even for identical bytes at the same path.
   */
  const seen = new Map<Id, Map<string, string>>();

  /** NUL appears in neither a project id nor a project-relative path. */
  const seenKey = (projectId: Id, rel: string): string => `${projectId}\u0000${rel}`;

  function remember(chatId: Id, projectId: Id, rel: string, hash: string): void {
    let record = seen.get(chatId);
    if (!record) {
      record = new Map();
      seen.set(chatId, record);
    }
    const key = seenKey(projectId, rel);
    record.delete(key);
    record.set(key, hash);
    while (record.size > MAX_SEEN_PATHS) {
      const oldest = record.keys().next().value;
      if (oldest === undefined) break;
      record.delete(oldest);
    }
  }

  const forget = (chatId: Id, projectId: Id, rel: string): void => {
    seen.get(chatId)?.delete(seenKey(projectId, rel));
  };

  const seenHash = (chatId: Id, projectId: Id, rel: string): string | undefined =>
    seen.get(chatId)?.get(seenKey(projectId, rel));

  /** Warnings about the change storage itself go to the console when no logger is given, as other stored files do. */
  const storeLogger = deps.logger ?? consoleLogger;

  /** The chat's store file. Its path is also the key of the chat's store lock (`withFileLock`). */
  const storeFileOf = (chatId: Id): string => {
    if (!SAFE_ID.test(chatId)) throw new CoreError('not_found', 'Chat not found.');
    return paths.changesFile(chatId);
  };

  // STORE TRUST (invariant; see `storage-trust.ts`): `changes/` must be a real folder below the data dir, checked
  // right before every read, write, quarantine and delete of a store file, and the store file is opened without
  // following a link or blocking and must be a regular file. A read or update that finds anything else fails closed
  // (`unsafeStoreText`): nothing is read, moved or written there, and no project file is touched.
  const checkStoreDir = folderCheck(paths.root, paths.changesDir);

  /** Maps an unsafe store folder or file to the error the caller reports. */
  async function failClosed<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (!(err instanceof UnsafeStorageError)) throw err;
      storeLogger.warn(`changes: ${err.message}`);
      throw new CoreError('internal', unsafeStoreText);
    }
  }

  /**
   * The stored change set, or null when there is none (or it was corrupt and has been moved aside, as `JsonFile`
   * does). Only under the chat's store lock.
   */
  async function readStore(file: string): Promise<Store | null> {
    if ((await checkStoreDir({ create: false })) === 'missing') return null;
    const got = await readNoFollow(file);
    if (got.kind === 'missing') return null;
    if (got.kind !== 'ok') throw new UnsafeStorageError(file, 'file');
    let reason: string;
    try {
      const parsed = storeSchema.safeParse(JSON.parse(got.bytes.toString('utf8')));
      if (parsed.success) return parsed.data;
      reason = parsed.error.issues[0]?.message ?? 'schema mismatch';
    } catch (err) {
      reason = err instanceof Error ? err.message : 'invalid JSON';
    }
    // Moved aside, never deleted; the chat starts again from an empty store. The folder is checked again first: the
    // rename must not move anything outside storage.
    await checkStoreDir({ create: false });
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(file, backup);
      storeLogger.warn(`${path.basename(file)} is corrupt (${reason}); moved to ${path.basename(backup)}.`);
    } catch (err) {
      storeLogger.warn(`${path.basename(file)} is corrupt (${reason}) and could not be backed up: ${String(err)}`);
    }
    return null;
  }

  /** Replaces the store file atomically (the rename replaces the entry itself, never a link's target). */
  async function writeStore(file: string, store: Store): Promise<void> {
    await checkStoreDir({ create: true });
    await writeFileAtomic(file, `${JSON.stringify(store, null, 2)}\n`);
  }

  /** Only use under the chat's store lock (see `BlobStore`). `storeFileOf` has already vetted the id. */
  const blobsFor = (chatId: Id): BlobStore => createBlobStore(paths.root, paths.changesBlobDir(chatId));

  /**
   * Change stores whose last save failed after this chat's project files had already changed. In memory only (lost on
   * a crash or quit). While present it is the chat's store: every read starts from a clone of it, and the next
   * successful save clears it.
   */
  const unsaved = new Map<Id, Store>();

  /** The chat's store as this process knows it: the unsaved copy (cloned), else the file. Under the store lock only. */
  async function current(chatId: Id, file: string): Promise<Store | null> {
    const held = unsaved.get(chatId);
    return held ? structuredClone(held) : failClosed(() => readStore(file));
  }

  /** Saves the store (test hook first); success clears the unsaved copy. Throws like `writeStore`. Under the store lock. */
  async function save(chatId: Id, file: string, store: Store): Promise<void> {
    await failClosed(async () => {
      await deps.beforeStoreWrite?.({ chatId });
      await writeStore(file, store);
    });
    unsaved.delete(chatId);
  }

  /**
   * Read-modify-write under the chat's store lock, for operations that change no project file. `fn` must not call
   * `load`, `mutate` or `mutateFiles` (the lock isn't re-entrant).
   * LOCK ORDER: this store lock is taken first; inside `fn`, at most one project-file write lock at a time
   * (`withWriteLock`), never another chat's store lock. `fn` may read the chat's project (`chatProjectId`, which takes
   * only the chat file's own lock, briefly, and never while a write lock is held). `fn` works on a copy: a throw, or a
   * failed save, leaves the chat's store as it was. A successful save also persists an earlier unsaved store.
   */
  async function mutate<T>(chatId: Id, fn: (store: Store) => Promise<T> | T): Promise<T> {
    const file = storeFileOf(chatId);
    return withFileLock(file, async () => {
      const store = (await current(chatId, file)) ?? emptyStore();
      const result = await fn(store);
      await save(chatId, file, store);
      return result;
    });
  }

  /**
   * Read-modify-write for operations that change project files. LOCK ORDER as `mutate`. `fn` calls `diskChanged()`
   * right after each successful rename or unlink of a project file, and must not throw after that.
   * WRITES ARE NEVER HIDDEN (invariant): once a project file changed, the operation resolves with what it did, even
   * when the change history can't be saved. Then the store stays in `unsaved`, authoritative until a later save
   * succeeds, a warning is logged, and the result says `saved: false`.
   * 1. Flush first: an unsaved store is saved before anything else. If that fails the operation is refused (`refused`
   *    builds the error; an unsafe store keeps its own) before any project file is touched, so a chat never has more
   *    than one unrecorded mutation.
   * 2. Then as `mutate`, except for the failed save after `diskChanged()` above.
   * BLOBS OUTLIVE THE SAVED STORE (invariant): a stored original is deleted only once a store that no longer references
   * it has been saved, here, right after that save. Until then the last saved store (what a restart reads) may still
   * offer Undo from it. While a store is unsaved nothing is collected, so every blob that either the saved store or
   * the unsaved one references stays. `fn` never collects, except to drop a blob that only its own failed write added.
   */
  async function mutateFiles<T>(
    chatId: Id,
    fn: (store: Store, diskChanged: () => void) => Promise<T>,
    refused: () => CoreError = () => new CoreError('internal'),
  ): Promise<{ value: T; saved: boolean }> {
    const file = storeFileOf(chatId);
    return withFileLock(file, async () => {
      const held = unsaved.get(chatId);
      if (held) {
        await save(chatId, file, held).catch((err) => {
          storeLogger.warn(`changes: could not save the change history: ${String(err)}`);
          throw err instanceof CoreError ? err : refused();
        });
      }
      const store = (await current(chatId, file)) ?? emptyStore();
      let changed = false;
      const value = await fn(store, () => {
        changed = true;
      });
      let saved = true;
      try {
        await save(chatId, file, store);
      } catch (err) {
        if (!changed) throw err;
        saved = false;
        unsaved.set(chatId, store);
        storeLogger.warn(`changes: a project file changed but the change history could not be saved: ${String(err)}`);
      }
      // Never throws (`collectBlobs` catches): the operation's result stands.
      if (saved) await collectBlobs(chatId, store);
      return { value, saved };
    });
  }

  async function load(chatId: Id): Promise<Store> {
    const file = storeFileOf(chatId);
    return (await withFileLock(file, () => current(chatId, file))) ?? emptyStore();
  }

  async function chatProject(chatId: Id): Promise<ProjectCheck> {
    if (!deps.chatProjectId) return undefined;
    return deps.chatProjectId(chatId).catch(() => null);
  }

  /**
   * The project a non-empty pending set was made for: its binding; for an unbound set (an older build's) the chat's
   * current project, or `fallback` when that can't be read. Same rule as `stage` and `apply`.
   */
  async function pendingOrigin(store: Store, chatId: Id, fallback: Id): Promise<ProjectCheck> {
    if (store.pendingProjectId !== undefined) return store.pendingProjectId;
    const current = await chatProject(chatId);
    return current === undefined ? fallback : current;
  }

  function clearPending(store: Store): void {
    store.files = [];
    delete store.pendingProjectId;
    store.revision += 1;
  }

  /** Discards the pending set, recording it for the next note. Under the store lock only. */
  function discardPending(store: Store): void {
    if (store.files.length === 0) return;
    store.events.push({
      type: 'discarded',
      files: [...store.files].sort(byPath).map((f) => ({ path: f.path, kind: kindOf(f) })),
    });
    clearPending(store);
  }

  /**
   * Deletes the blobs no batch of `store` references any more. Under the store lock only, and only with a store that
   * is saved (see BLOBS OUTLIVE THE SAVED STORE in `mutateFiles`).
   */
  const collectBlobs = (chatId: Id, store: Store): Promise<void> =>
    blobsFor(chatId)
      .collect(referencedBlobs(store))
      .catch((err) => deps.logger?.warn(`changes: could not clean up stored originals: ${String(err)}`));

  /**
   * MOVE RESETS AUTO STATE (invariant): once a chat's project has changed, nothing the chat saw or wrote in the old
   * project carries over: every open Auto batch is closed (no later write joins it, the same turn's included) and the
   * chat's read records are cleared, for every project. Under the store lock only, right after the commit. Never
   * throws: the move itself has committed; a failed save keeps the store in memory (`unsaved`).
   */
  async function resetForMove(chatId: Id, file: string, store: Store | null): Promise<void> {
    seen.delete(chatId);
    if (!store) return; // no change history: still no store file
    let closed = 0;
    for (const b of store.applied) {
      if (b.source === 'auto' && !b.closed && !b.undo && b.undoData !== undefined) {
        b.closed = true;
        closed += 1;
      }
    }
    if (closed === 0) return;
    try {
      await save(chatId, file, store);
    } catch (err) {
      unsaved.set(chatId, store);
      storeLogger.warn(`changes: could not save the closed batches after a move: ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------------------------- staging (Review)

  async function stage(
    chatId: Id,
    projectId: Id,
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
      // PROPOSALS STAY IN THEIR PROJECT (invariant): a pending set holds proposals for one project only, the one its
      // first stage ran in, so applying it can never write a proposal into a project it wasn't made for. An unbound
      // non-empty set (an older build's store) counts as made for the chat's current project, as `apply` treats it;
      // without a way to read that project, as made for the staging turn's. The chat's project is read under the store
      // lock, where a move can't change it (see `changeProject`).
      if (store.files.length > 0 && (await pendingOrigin(store, chatId, projectId)) !== projectId) {
        throw new CoreError('conflict', OTHER_PROJECT_PENDING_TEXT);
      }
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
          if (text === null && content !== null) throw new CoreError('unsupported_file', binaryTargetText(rel));
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
        throw new CoreError('unsupported_file', binaryTargetText(rel));
      }

      const next = keepCrlf(rec.baseContent, content);
      // The limit holds for the bytes the proposal would write, CRLF line endings included. The throw leaves the set
      // unchanged.
      if (next !== null && Buffer.byteLength(next) > LIMITS.writeFileMaxBytes) {
        throw new CoreError('file_too_large', writtenTooLargeText('review', rel, Buffer.byteLength(next)));
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
          throw new CoreError('conflict', tooManyProposedText(LIMITS.pendingFilesPerChat));
        }
        store.files = [...others, rec];
      }

      if (!(noop && isNew)) {
        store.revision += 1;
        store.messageId = messageId;
      }
      if (store.files.length > 0) store.pendingProjectId = projectId;
      else delete store.pendingProjectId;
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
  ): Promise<{ file: FileChange | null; batchId: Id | null; unsaved?: true }> {
    const { chatId, projectId, projectRoot } = turn;
    if (content !== null) validateContent(relPath, content);
    const target = await resolveTarget(projectRoot, relPath, deps.sandbox);
    if (!target.ok) throw targetError(target, relPath);
    const rel = target.rel;
    // This first resolution pins the write (see PINNED ROOT).
    const pin: Pin = { root: target.root, abs: target.abs };

    const writeInStore = async (
      store: Store,
      diskChanged: () => void,
    ): Promise<{ file: FileChange | null; batchId: Id | null }> => {
      // Writing over a pending proposal would make its review meaningless; the pending set stays untouched. Compared
      // case- and Unicode-folded: a spelling that might be the same file on this disk is refused too.
      if (store.files.some((f) => sameFoldedRel(f.path, rel))) throw new CoreError('conflict', autoPendingText(rel));

      const blobs = blobsFor(chatId);
      // LOCK ORDER: the chat's store lock (held by `mutateFiles`), then this one file's write lock. No other lock inside.
      return withWriteLock(target.abs, async () => {
        const disk = await readOnDisk(target.abs).catch((err) => {
          deps.logger?.warn(`auto write: could not read ${rel}: ${String(err)}`);
          throw new CoreError('internal', autoWriteFailedText(rel));
        });
        if (disk.kind === 'other') throw badPath(`${rel} is not a regular file.`);
        // Checked here, under the lock and before anything is hashed or copied into a blob (deletes included).
        if (disk.kind === 'tooLarge') throw new CoreError('file_too_large', autoSourceTooLargeText(rel));
        const current = disk.kind === 'file' ? disk : null;
        const currentHash = current?.hash ?? '';

        // Race check: the tool built the change from these exact bytes (or from "missing").
        if (currentHash !== opts.baseHash) throw new CoreError('conflict', autoStaleText(rel));
        // Stale-read guard: never overwrite bytes this chat hasn't seen. `edit_file` may go without a read, since its
        // old_string must match the current text exactly; replacing or deleting a whole file needs one.
        if (current) {
          const lastSeen = seenHash(chatId, projectId, rel);
          if (lastSeen === undefined && opts.tool !== 'edit_file') {
            throw new CoreError('conflict', autoUnreadText(rel));
          }
          if (lastSeen !== undefined && lastSeen !== currentHash) throw new CoreError('conflict', autoStaleText(rel));
          if (current.text === null && content !== null) throw new CoreError('unsupported_file', binaryTargetText(rel));
        } else if (content === null) {
          throw new CoreError('not_found', `${rel} does not exist.`);
        }

        const next = keepCrlf(current?.text ?? null, content);
        const nextBytes = next === null ? null : Buffer.from(next, 'utf8');
        // The limit holds for the bytes that reach the disk, CRLF line endings included: checked before the blob, the
        // folders or the mutation.
        if (nextBytes !== null && nextBytes.length > LIMITS.writeFileMaxBytes) {
          throw new CoreError('file_too_large', writtenTooLargeText('auto', rel, nextBytes.length));
        }
        if (current && nextBytes?.equals(current.bytes)) return { file: null, batchId: null };

        // The turn's open batch, or a new one. Nothing is stored until the write has succeeded. A BATCH NEVER SPANS
        // PROJECTS (invariant): only a batch of this turn written into this same project and not closed by a move
        // (see `changeProject`) is joined, so Undo of one batch can never touch a file the turn wrote in another
        // project.
        const open = store.applied.find(
          (b) =>
            b.source === 'auto' &&
            b.turnId === turn.turnId &&
            b.projectId === projectId &&
            !b.closed &&
            !b.undo &&
            b.undoData !== undefined,
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
          // The checks above ran before the blob write, the folder creation and the hook; `replaceChecked` repeats
          // them as its last step: the path must still resolve to the same file under the same project root (nothing
          // turned into a link, the project folder wasn't swapped), and its bytes must still be the ones checked (or
          // still missing).
          const recheck = async (): Promise<CoreError | null> => {
            const again = await resolveTarget(projectRoot, rel, deps.sandbox);
            if (!again.ok || again.rel !== rel) {
              return badPath(again.ok ? `Path goes through a symbolic link: ${rel}` : `${again.message}: ${rel}`);
            }
            if (!samePlace(again, pin)) return badPath(movedText(rel));
            const now = hashOnDisk(await readOnDisk(target.abs));
            return now === currentHash ? null : new CoreError('conflict', autoStaleText(rel));
          };
          const refused = await replaceChecked(target.abs, nextBytes, current?.mode ?? 0o644, recheck, {
            exactMode: true,
            logger: deps.logger,
          });
          if (refused) throw refused;
          // The project file has changed: from here on nothing may throw (WRITES ARE NEVER HIDDEN).
          diskChanged();
        } catch (err) {
          // Drop a blob that only this failed write referenced. `store` is still exactly the saved store (an unsaved
          // one was flushed first and nothing has been recorded yet), so no blob it references can go.
          await collectBlobs(chatId, store);
          if (err instanceof CoreError) throw err;
          deps.logger?.warn(`auto write: could not write ${rel}: ${String(err)}`);
          throw new CoreError('internal', autoWriteFailedText(rel));
        }

        // Record: the file's diff from before the turn to now, and what Undo will compare against. None of this throws:
        // `blobs.get` returns null on failure and `diffFile` is pure. The originals retention dropped are collected by
        // `mutateFiles`, once this store is saved.
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
        if (afterHash === null) forget(chatId, projectId, rel);
        else remember(chatId, projectId, rel, afterHash);

        const base = current ? (current.text ?? '') : null;
        return { file: diffFile(rel, base, next), batchId: batch.id };
      });
    };

    const { value, saved } = await mutateFiles(
      chatId,
      writeInStore,
      // A history that still can't be saved refuses the write before the project file is touched.
      () => new CoreError('internal', autoWriteFailedText(rel)),
    );
    return saved ? value : { ...value, unsaved: true };
  }

  // -------------------------------------------------------------------------------------------- undo (Auto)

  /**
   * Puts one file back as it was before the turn, if it is still exactly what the turn left. Returns why it was
   * skipped, or null when restored. Called under the chat's store lock; takes the file's write lock itself.
   */
  async function undoFile(
    chatId: Id,
    project: { root: string; real: string | null },
    e: UndoEntry,
    blobs: BlobStore,
  ): Promise<UndoSkipReason | null> {
    const projectRoot = project.root;
    const target = await resolveTarget(projectRoot, e.path, deps.sandbox);
    // The project root is pinned for the whole undo, the file's path from this first resolution (see PINNED ROOT).
    if (!target.ok || target.rel !== e.path || target.root !== project.real) return 'blocked';
    const pin: Pin = { root: target.root, abs: target.abs };
    // LOCK ORDER: the chat's store lock (held by the caller's `mutateFiles`), then this one file's write lock.
    return withWriteLock(target.abs, async () => {
      // Never touch a file that changed after the turn: Undo must not destroy later work.
      const untouched = (disk: OnDisk): boolean =>
        e.afterHash === null ? disk.kind === 'missing' : hashOnDisk(disk) === e.afterHash;
      const disk = await readOnDisk(target.abs).catch(() => null);
      if (disk === null) return 'blocked';
      if (!untouched(disk)) return 'changed_since';
      let original: Buffer | null = null;
      if (e.before) {
        original = await blobs.get(e.before.hash);
        if (original === null) return 'unavailable';
      }
      try {
        if (original) await fs.mkdir(path.dirname(target.abs), { recursive: true });
        await deps.beforeWrite?.({ op: 'undo', chatId, path: e.path });
        // Repeated by `replaceChecked` as its last step, after the blob read, the folder creation and the hook.
        const recheck = async (): Promise<UndoSkipReason | null> => {
          const again = await resolveTarget(projectRoot, e.path, deps.sandbox);
          if (!again.ok || again.rel !== e.path || !samePlace(again, pin)) return 'blocked';
          return untouched(await readOnDisk(target.abs)) ? null : 'changed_since';
        };
        const restore = original === null || e.before === null ? null : original;
        return await replaceChecked(target.abs, restore, e.before?.mode ?? 0o644, recheck, {
          exactMode: true,
          logger: deps.logger,
        });
      } catch (err) {
        deps.logger?.warn(`undo: could not restore ${e.path}: ${String(err)}`);
        return 'blocked';
      }
    });
  }

  /**
   * Undoes one batch in place (it must still have its undo data). Under the chat's store lock only (`mutateFiles`,
   * whose `diskChanged` is called for each restored file; nothing here throws). `project.real` is the project's real
   * root, pinned once by the caller for the whole undo (see PINNED ROOT). A path in `held`, or any spelling of one (see
   * `respelledPaths`), was skipped by a later batch of the same undo: it is never touched and is reported as skipped
   * for that reason. SPELLINGS OF ONE FILE ARE UNDONE TOGETHER OR NOT AT ALL (see `respelledPaths`): entries of this
   * batch whose paths share a fold are all skipped as `blocked`, decided before the first file is touched.
   */
  async function undoInStore(
    chatId: Id,
    project: { root: string; real: string | null },
    store: Store,
    batch: StoredBatch,
    by: BatchUndo['by'],
    diskChanged: () => void,
    held?: ReadonlyMap<string, UndoSkipReason>,
  ): Promise<BatchUndo> {
    const blobs = blobsFor(chatId);
    const restored: string[] = [];
    const skipped: BatchUndo['skipped'] = [];
    const entries = [...(batch.undoData ?? [])].sort(byPath);
    const respelled = respelledPaths(entries.map((e) => e.path));
    for (const e of entries) {
      const reason =
        heldReason(held, e.path) ??
        (respelled.has(e.path) ? 'blocked' : null) ??
        (await undoFile(chatId, project, e, blobs));
      if (reason) skipped.push({ path: e.path, reason });
      else {
        diskChanged();
        restored.push(e.path);
      }
    }
    const undo: BatchUndo = { at: now().toISOString(), by, restored, skipped };
    batch.undo = undo;
    delete batch.undoData;
    if (restored.length > 0) store.diskSeq = (store.diskSeq ?? 0) + 1;
    for (const p of restored) forget(chatId, batch.projectId ?? '', p);
    // A user's undo goes into the next note; a retry's doesn't (the retried message's note says it instead).
    if (by === 'user') store.undone = [...(store.undone ?? []), { restored, skipped }];
    // The batch's originals are collected by `mutateFiles`, once this store is saved.
    return undo;
  }

  const notUndoable = () => new CoreError('conflict', 'These edits can no longer be undone.');

  // -------------------------------------------------------------------------------------------- apply (Review)

  /** The file must still resolve to `pin` (see PINNED ROOT) and be as the proposal expects. */
  async function checkConflict(
    projectRoot: string,
    rec: StoredFile,
    kind: ChangeKind,
    pin: Pin,
  ): Promise<{ reason: ApplyConflictReason } | { abs: string; mode: number; root: string }> {
    const target = await resolveTarget(projectRoot, rec.path, deps.sandbox);
    if (!target.ok || target.rel !== rec.path || !samePlace(target, pin)) return { reason: 'blocked' };
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
    projectId: Id;
    projectRoot: string;
    expectedProjectId?: Id | null;
    revision: number;
    decisions: Record<string, Record<string, HunkDecision>>;
  }): Promise<{ batch: AppliedBatch; changes: ChatChanges }> {
    const { value } = await mutateFiles(input.chatId, async (store, diskChanged) => {
      // PROPOSALS STAY IN THEIR PROJECT (invariant): checked under the store lock, before anything is written, and the
      // lock is held through the writes. The chat's current project is read here, not taken from the caller: a move or
      // a detach commits under this same lock (`changeProject`), so the project can't change between this check and
      // the last write. The project `projectRoot` belongs to (what the caller read earlier), the project the proposals
      // were made for (unbound = the chat's current one) and the project the client showed (when sent) must all be
      // the chat's current project. Otherwise nothing is written and the set stays pending, so the user can discard it.
      // LOCK ORDER: the chat's store lock (held by `mutateFiles`), then the chat's file lock for this read (`chatProjectId`,
      // released at once), then the per-file write locks below.
      const read = await chatProject(input.chatId);
      const project = read === undefined ? input.projectId : read;
      if (project !== input.projectId) throw new CoreError('conflict', APPLY_PROJECT_CHANGED);
      if (store.files.length > 0 && (store.pendingProjectId ?? project) !== project) {
        throw new CoreError('conflict', PROPOSALS_OTHER_PROJECT);
      }
      if (input.expectedProjectId !== undefined && input.expectedProjectId !== project) {
        throw new CoreError('conflict', APPLY_PROJECT_CHANGED);
      }
      if (store.files.length === 0 || input.revision !== store.revision) throw new CoreError('changes_stale');

      const written: FileChange[] = [];
      const conflicts: AppliedBatch['conflicts'] = [];
      const tooLarge: string[] = [];
      const ev = { written: [] as NoteFile[], rejected: [] as NoteFile[], skipped: [] as NoteFile[] };
      let rejectedHunks = 0;
      let skippedHunks = 0;
      // Pinned once for the whole apply (see PINNED ROOT).
      const realRoot = await pinRoot(input.projectRoot);

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

        // NOTHING THROWS PAST A WRITE (see `mutateFiles`): an earlier file may already be on disk, so every failure from
        // here to the end of this file (resolving, the conflict check, building the text, the write) refuses this file
        // as `blocked`, and the apply goes on and is recorded.
        const target = await resolveTarget(input.projectRoot, rec.path, deps.sandbox).catch((err) => {
          deps.logger?.warn(`apply: could not resolve ${rec.path}: ${String(err)}`);
          return null;
        });
        if (!target?.ok || target.rel !== rec.path || target.root !== realRoot) {
          conflicts.push({ path: rec.path, reason: 'blocked' });
          continue;
        }
        const pin: Pin = { root: target.root, abs: target.abs };
        // LOCK ORDER: the chat's store lock (held by `mutateFiles`), then this one file's write lock, released before the
        // next file. The hash check and the write happen under it, so an auto write in another chat can't slip in.
        const outcome = await withWriteLock(target.abs, async (): Promise<ApplyConflictReason | null> => {
          try {
            const check = await checkConflict(input.projectRoot, rec, change.kind, pin);
            if ('reason' in check) return check.reason;
            const text = change.kind === 'delete' ? null : applyHunks(rec.baseContent, rec.content, accepted);
            // The write limit holds for the bytes this apply would write, CRLF included. Staging checked the whole
            // proposal; accepting only some hunks (keeping base lines another hunk removed) can make the file larger.
            if (text !== null && Buffer.byteLength(text) > LIMITS.writeFileMaxBytes) return 'too_large';
            rejectedHunks += rejected;
            skippedHunks += undecided;
            if (text !== null) await fs.mkdir(path.dirname(check.abs), { recursive: true });
            await deps.beforeWrite?.({ op: 'apply', chatId: input.chatId, path: rec.path });
            // The same check again as `replaceChecked`'s last step, after the folder creation and the hook: re-resolve
            // (a parent or the project folder swapped for a link is `blocked`, for deletes too) and the existence and
            // hash check.
            const recheck = async (): Promise<ApplyConflictReason | null> => {
              const again = await checkConflict(input.projectRoot, rec, change.kind, pin);
              return 'reason' in again ? again.reason : null;
            };
            return await replaceChecked(check.abs, text, check.mode, recheck, {
              exactMode: false,
              logger: deps.logger,
            });
          } catch (err) {
            deps.logger?.warn(`apply: could not write ${rec.path}: ${String(err)}`);
            return 'blocked';
          }
        }).catch((err): ApplyConflictReason => {
          deps.logger?.warn(`apply: could not lock ${rec.path}: ${String(err)}`);
          return 'blocked';
        });
        if (outcome !== null) {
          conflicts.push({ path: rec.path, reason: outcome });
          if (outcome === 'too_large') tooLarge.push(rec.path);
          continue;
        }
        diskChanged();
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
        // Auto batches may drop off the list; `mutateFiles` collects their originals once this store is saved.
        store.applied = [...store.applied, batch].slice(-MAX_APPLIED);
      }
      if (written.length > 0) store.diskSeq = (store.diskSeq ?? 0) + 1;
      clearPending(store);
      return { batch: batchOf(batch, read), changes: chatChangesOf(store, read) };
    });
    return value;
  }

  // -------------------------------------------------------------------------------------------- service

  return {
    get: async (chatId) => {
      const project = await chatProject(chatId);
      return chatChangesOf(await load(chatId), project);
    },

    tools({ chatId, projectId, projectRoot, messageId, turnId, mode }): TurnChanges {
      /**
       * OVERLAYS STAY IN THEIR PROJECT (invariant): proposals are read through only by a turn pinned to their project,
       * so a turn in another project sees that project's disk, never proposals made elsewhere.
       * LOCK ORDER: the store lock (`load`, released), then, for an unbound set only, the chat file's lock.
       */
      async function ownPending(): Promise<StoredFile[]> {
        const store = await load(chatId);
        if (store.files.length === 0) return [];
        return (await pendingOrigin(store, chatId, projectId)) === projectId ? store.files : [];
      }
      return {
        mode,
        async read(relPath) {
          const target = await resolveTarget(projectRoot, relPath, deps.sandbox);
          // Not resolvable: let the read tool report the problem against the disk.
          const key = target.ok ? target.rel : null;
          if (key === null) return null;
          const rec = (await ownPending()).find((f) => f.path === key);
          if (!rec) return null;
          return rec.content === null ? { kind: 'deleted' } : { kind: 'staged', content: rec.content };
        },
        async staged() {
          return [...(await ownPending())].sort(byPath).map((f) => ({ path: f.path, kind: kindOf(f) }));
        },
        async stage(relPath, content) {
          if (mode !== 'review') throw new Error('stage() is for Review turns; this turn is in Auto.');
          return stage(chatId, projectId, projectRoot, messageId, relPath, content);
        },
        async write(relPath, content, opts) {
          if (mode !== 'auto') throw new Error('write() is for Auto turns; this turn is in Review.');
          return autoWrite({ chatId, projectId, projectRoot, messageId, turnId }, relPath, content, opts);
        },
        // Recorded under this turn's pinned project, also when the loop commits a read late, after a move.
        noteRead(relPath, bytes) {
          remember(chatId, projectId, relPath, sha256(bytes));
        },
        // The same record from the digest of the bytes, taken by the loop when the tool read them.
        noteReadHash(relPath, hash) {
          remember(chatId, projectId, relPath, hash);
        },
      };
    },

    snapshot: (chatId, userMessageId) =>
      mutate(chatId, async (store) => {
        // The binding travels with the set, so a retry after a move can't bring proposals back unbound. An unbound set
        // (an older build's) is made for the chat's current project, which is still known here: read under the store
        // lock, where a move can't change it, and recorded as the snapshot's project. When it can't be read, the
        // snapshot names none and `restore` binds it to `UNKNOWN_PROJECT`.
        // LOCK ORDER: the chat's store lock (held by `mutate`), then the chat's file lock for this read only.
        let origin: Id | undefined;
        if (store.files.length > 0) origin = store.pendingProjectId ?? (await chatProject(chatId)) ?? undefined;
        const snap = {
          userMessageId,
          revision: store.revision,
          messageId: store.messageId,
          files: structuredClone(store.files),
          ...(origin !== undefined ? { projectId: origin } : {}),
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
        // A non-empty snapshot that names no project (an older build's, or one whose project couldn't be read) comes
        // back bound to `UNKNOWN_PROJECT`, never to whatever project the chat is in now: Apply refuses it, Discard
        // clears it.
        if (snap.files.length > 0) store.pendingProjectId = snap.projectId ?? UNKNOWN_PROJECT;
        else delete store.pendingProjectId;
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
        discardPending(store);
        return chatChangesOf(store, project);
      });
    },

    // MOVES WAIT FOR APPLY (invariant): a change of the chat's project commits under the chat's store lock, with its
    // pending check, so it can't land between a stage and the move's check, or between Apply's project check and its
    // writes (both run under this lock). Reads the store without writing it, so a chat with no change history gets no
    // store file; `discard` writes it at once, before `commit`.
    // MOVE RESETS AUTO STATE (invariant): once the chat's project has changed (read before and after `commit`, also
    // when `commit` threw after writing), its per-project Auto state is reset still under this lock (`resetForMove`).
    // A no-op or refused move resets nothing; without `chatProjectId`, any successful commit resets.
    // LOCK ORDER: this store lock first, then the chat's file lock for the `before` read (released), then whatever
    // `commit` takes (the chat storage lock, then the chat's file lock), then the chat's file lock for the `after`
    // read. `commit` must not call this service: the store lock isn't re-entrant.
    changeProject: async (chatId, commit) => {
      const file = storeFileOf(chatId);
      return withFileLock(file, async () => {
        const store = await current(chatId, file);
        const before = await chatProject(chatId);
        const pending = store !== null && store.files.length > 0;
        let discarded = false;
        const discard = async (): Promise<void> => {
          if (!store || !pending || discarded) return;
          discardPending(store);
          await save(chatId, file, store);
          discarded = true;
        };
        let committed = false;
        try {
          const result = await commit({ pending, discard });
          committed = true;
          return result;
        } finally {
          const after = before === undefined ? undefined : await chatProject(chatId);
          const moved = before === undefined ? committed : after !== before;
          if (moved) await resetForMove(chatId, file, store);
        }
      });
    },

    undoBatch: async ({ chatId, projectId, projectRoot, batchId }) => {
      const { value } = await mutateFiles(chatId, async (store, diskChanged) => {
        const batch = store.applied.find((b) => b.id === batchId);
        // Throwing before any change also keeps an unknown chat from getting an empty store file.
        if (!batch) throw new CoreError('not_found', 'These edits were not found.');
        // The chat's current project is read here, under the store lock, not taken from the caller: a move or a detach
        // commits under this same lock (`changeProject`), so it can't land between this check and the last restore.
        // LOCK ORDER: the store lock (held by `mutateFiles`), then the chat's file lock for this read (released at
        // once), then one file's write lock at a time.
        const read = await chatProject(chatId);
        const current = read === undefined ? projectId : read;
        if (current === null) throw new CoreError('conflict', CHAT_HAS_NO_PROJECT);
        if (current !== projectId) throw notUndoable();
        if (batch.source !== 'auto' || batch.undo || !batch.undoData || batch.projectId !== current) {
          throw notUndoable();
        }
        const project = { root: projectRoot, real: await pinRoot(projectRoot) };
        await undoInStore(chatId, project, store, batch, 'user', diskChanged);
        return { batch: batchOf(batch, current), changes: chatChangesOf(store, current) };
      });
      return value;
    },

    retryInfo: async ({ chatId, turnId, projectId }) => {
      const store = await load(chatId);
      const elsewhere = new Set<Id>();
      for (const b of store.applied) {
        if (b.source !== 'auto' || b.turnId !== turnId || b.undo || b.undoData === undefined) continue;
        if ((b.projectId ?? '') !== (projectId ?? '')) elsewhere.add(b.projectId ?? '');
      }
      return { writtenElsewhere: [...elsewhere], lastMode: store.lastMode ?? 'review' };
    },

    prepareRetry: async ({ chatId, projectId, projectRoot, turnId, mode }) => {
      const { value } = await mutateFiles(chatId, async (store, diskChanged) => {
        store.lastMode = mode;
        // Batches past retention or written into another project can't be undone; they are left as they are. A batch
        // closed by a move is undone like any other of the turn in this project.
        // NEWEST FIRST (invariant): were a turn's writes ever split into several batches (a move closes the open batch;
        // the routes refuse a move while a turn runs, so this is defence in depth), two of them could hold the same
        // file. Each batch's entry expects the bytes its own write
        // left, which only holds once every later write of that file has been undone, so the batches are undone in the
        // reverse of the order they were opened in (`applied` is in that order). Oldest first would skip the first
        // write as `changed_since` and then restore its bytes from the second one's original.
        // A SKIP HOLDS FOR OLDER BATCHES (invariant): once a later batch skips a path, no older batch touches it. The
        // later write is what the skip protects (the user changed the file after it, perhaps back to the bytes an
        // older write left), so an older batch whose entry happens to match must not delete or overwrite it. Paths a
        // later batch restored go on to the older batches as usual. A held path also holds every other spelling of
        // it (see `respelledPaths`).
        // SPELLINGS OF ONE FILE ARE UNDONE TOGETHER OR NOT AT ALL (invariant, see `respelledPaths`), across all the
        // batches undone here: a path with another spelling in any of them is held as `blocked` before the first
        // batch touches the disk, so no batch undoes either spelling.
        const batches = store.applied
          .filter(
            (b) =>
              b.source === 'auto' &&
              b.turnId === turnId &&
              !b.undo &&
              b.undoData !== undefined &&
              b.projectId === projectId,
          )
          .reverse();
        const project = { root: projectRoot, real: batches.length > 0 ? await pinRoot(projectRoot) : null };
        const undos: BatchUndo[] = [];
        // Each path's first skip, newest batch first: carried into every older batch and kept as the reported reason.
        const held = new Map<string, UndoSkipReason>();
        for (const p of respelledPaths(batches.flatMap((b) => (b.undoData ?? []).map((e) => e.path)))) {
          held.set(p, 'blocked');
        }
        for (const batch of batches) {
          const undo = await undoInStore(chatId, project, store, batch, 'retry', diskChanged, held);
          for (const s of undo.skipped) if (!held.has(s.path)) held.set(s.path, s.reason);
          undos.push(undo);
        }
        const last = undos.at(-1);
        const oldest = batches.at(-1);
        let result: { batchId: Id; undo: BatchUndo } | null = null;
        if (last && oldest) {
          // One report per path: a file any batch had to skip is reported as skipped (the reason of the newest batch
          // that skipped it), so the model reads it again; the others are restored.
          const skipped = [...held].map(([path, reason]) => ({ path, reason })).sort(byPath);
          const restored = new Set(undos.flatMap((u) => u.restored).filter((p) => !held.has(p)));
          result = { batchId: oldest.id, undo: { ...last, restored: [...restored].sort(), skipped } };
        }
        // The retry starts over: the model must read again before overwriting anything, in every project.
        seen.delete(chatId);
        return result;
      });
      return value;
    },

    removeForChat: async (chatId) => {
      const file = storeFileOf(chatId);
      seen.delete(chatId);
      // Under the store lock (keyed by the store file's path), so no write of this chat can add a blob while its
      // folder goes.
      await withFileLock(file, async () => {
        unsaved.delete(chatId);
        // A `changes/` folder that isn't a real folder (a link planted in the data dir) is left alone, like an unsafe
        // blob folder below: the chat itself is still removed, and nothing outside storage is deleted.
        const dir = await checkStoreDir({ create: false }).catch((err) => {
          storeLogger.warn(`changes: could not remove the change history: ${String(err)}`);
          return 'unsafe' as const;
        });
        // `unlink` removes the file, or a link in its place, never a link's target.
        if (dir === 'ok') {
          await fs.unlink(file).catch((err) => {
            if (!isNotFound(err)) throw err;
          });
        }
        // A blob folder that isn't safe to remove (a link planted in the data dir) is left alone: the chat itself is
        // still removed, and nothing outside storage is touched.
        await blobsFor(chatId)
          .removeAll()
          .catch((err) => deps.logger?.warn(`changes: could not remove stored originals: ${String(err)}`));
      });
    },
  };
}
