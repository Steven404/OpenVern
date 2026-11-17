// The change service's own files below the data dir (each chat's change store `changes/<chatId>.json` and its blob
// folder `changes/<chatId>.blobs/`): the folder check and the reads every operation on them goes through.
//
// TRUST (invariant): only the data dir itself is trusted (it may be reached through a link the user chose). Every
// folder from it down to the one an operation uses must be a real directory, never a symlink, checked right before
// each read, write, quarantine or delete. Files there are opened without following a link and without blocking, and
// must be regular files. Otherwise a link planted in the data dir would make the app read, write or delete files
// outside storage, and a FIFO in a file's place would hang a read that holds the chat's locks.

import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { isNotFound } from '../storage/json-file';

/** Thrown when a folder or file of the change storage is a symlink or the wrong kind of entry. Nothing was touched. */
export class UnsafeStorageError extends Error {
  constructor(target: string, what: 'folder' | 'file') {
    super(
      `Refusing to use ${target}: it is a symbolic link or not a ${what === 'folder' ? 'folder' : 'regular file'}.`,
    );
    this.name = 'UnsafeStorageError';
  }
}

export interface FolderCheckOptions {
  /** Create a missing folder (owner-only), then check it like the others. Otherwise a missing one is 'missing'. */
  create: boolean;
  /** Check only the folders above `dir`, for an operation that handles `dir` itself (removing it). */
  parentsOnly?: boolean;
}

/**
 * Returns the check of every folder from below `root` down to `dir`: each must be a real directory (`lstat`, so a
 * symlink is refused). It throws `UnsafeStorageError` before anything is read, written or deleted.
 *
 * LIMIT: this narrows a race with a program running as the same user, but can't close it. Node has no `openat`-style
 * calls, so every later call resolves the path again: a folder swapped for a link after the check is followed. Model
 * edits can't do that (the sandbox keeps them out of the data dir), and a program that can could change the data dir
 * directly anyway. Closing it would take a native dependency.
 *
 * @param root the data dir: trusted as it is.
 * @param dir a folder below `root`.
 */
export function folderCheck(root: string, dir: string): (opts: FolderCheckOptions) => Promise<'ok' | 'missing'> {
  const steps = path.relative(root, dir).split(path.sep);
  if (steps.length === 0 || steps.some((s) => s === '' || s === '.' || s === '..') || path.isAbsolute(steps[0] ?? '')) {
    throw new Error(`${dir} is not inside ${root}`);
  }
  return async function checkDirs({ create, parentsOnly = false }) {
    let cur = root;
    for (const step of parentsOnly ? steps.slice(0, -1) : steps) {
      cur = path.join(cur, step);
      let info = await fs.lstat(cur).catch((err) => {
        if (isNotFound(err)) return null;
        throw err;
      });
      if (info === null) {
        if (!create) return 'missing';
        // The data dir is owner-only; what lies below holds copies of project files, so these folders are too.
        await fs.mkdir(cur, { mode: 0o700 }).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        });
        info = await fs.lstat(cur);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafeStorageError(cur, 'folder');
    }
    return 'ok';
  };
}

/** Up to `limit` bytes from the handle's position to its end; null when there are more. */
export async function readAtMost(handle: fs.FileHandle, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    // Never more than `limit + 1` bytes in all: one past the limit is enough to know the file is over it.
    const buf = Buffer.allocUnsafe(Math.min(limit + 1 - total, 1024 * 1024));
    const { bytesRead } = await handle.read(buf, 0, buf.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    chunks.push(buf.subarray(0, bytesRead));
    total += bytesRead;
    if (total > limit) return null;
  }
}

/** A file read by `readNoFollow`. `unsafe`: a link, or not a regular file. `tooLarge`: over the limit; not read. */
export type NoFollowRead =
  | { kind: 'missing' }
  | { kind: 'unsafe' }
  | { kind: 'tooLarge' }
  | { kind: 'ok'; bytes: Buffer };

/**
 * A regular file's bytes, never through a link in its last component and never blocking: opened with `O_NOFOLLOW`
 * and `O_NONBLOCK` (a FIFO opens at once, then fails the type check), then checked on the open handle (`fstat`) to be
 * a regular file of at most `maxBytes`. At most `maxBytes + 1` bytes are ever read, so a file that grew is still
 * caught without loading it. The `lstat` first is the link check on platforms without `O_NOFOLLOW`.
 */
export async function readNoFollow(file: string, maxBytes = Number.POSITIVE_INFINITY): Promise<NoFollowRead> {
  const info = await fs.lstat(file).catch((err) => {
    if (isNotFound(err)) return null;
    throw err;
  });
  if (info === null) return { kind: 'missing' };
  if (!info.isFile()) return { kind: 'unsafe' };
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (isNotFound(err)) return { kind: 'missing' };
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') return { kind: 'unsafe' };
    throw err;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { kind: 'unsafe' };
    if (opened.size > maxBytes) return { kind: 'tooLarge' };
    const bytes = await readAtMost(handle, maxBytes);
    return bytes === null ? { kind: 'tooLarge' } : { kind: 'ok', bytes };
  } finally {
    await handle.close();
  }
}
