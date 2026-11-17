// Per-file write lock for project files. Serialises every check-then-write the app makes on one physical file, so
// two chats (or an apply and an auto write) can never both pass the on-disk hash check and both write.
//
// LOCK ORDER (invariant; every caller must follow it, or two callers can deadlock):
//   1. a chat's change-store lock (the `JsonFile` lock on `changes/<chatId>.json`) first,
//   2. then at most ONE project-file write lock at a time, taken and released per file.
// Never take a store lock while holding a write lock, never hold two write locks at once, and never hold two
// chats' store locks at once. With one order everywhere no cycle of waits can form.
//
// Writes by other programs (the user's editor, terminal commands) can't be locked. The callers re-check the file's
// hash right before writing, so that window is a few milliseconds.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withFileLock } from '../storage/mutex';

const KEY_PREFIX = 'project-file:';

/**
 * The real path of `abs`, resolving symlinks in the part that exists: a missing file maps to its nearest existing
 * ancestor's real path plus the remaining names.
 */
async function realPathOf(abs: string): Promise<string> {
  try {
    return await fs.realpath(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(await realPathOf(parent), path.basename(abs));
  }
}

/**
 * The lock key for an absolute project file path: its real path, NFC-normalised and lower-cased. Lower-casing can
 * only over-serialise two names that differ by case; in exchange, nested projects and case-insensitive disks share
 * one lock per physical file.
 */
export async function fileLockKey(abs: string): Promise<string> {
  return KEY_PREFIX + (await realPathOf(abs)).normalize('NFC').toLowerCase();
}

/**
 * Runs `fn` holding the write lock of the project file at `abs`. The caller must already hold its chat's store lock
 * (or no lock) and must not take another write lock or any store lock inside `fn` (see the lock order above).
 */
export async function withWriteLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(await fileLockKey(abs), fn);
}
