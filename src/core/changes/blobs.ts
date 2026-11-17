// Content-addressed copies of project files, kept so Undo can restore an Auto turn's originals. One folder per chat
// (`changes/<chatId>.blobs/`), one file per original named by the sha256 of its bytes, shared between that chat's
// batches. Every call must run under the chat's change-store lock: `collect` decides what is unreferenced from the
// store, and a concurrent `put` could otherwise lose a blob it just wrote.
//
// TRUST (invariant; see `storage-trust.ts`): only the data dir itself (`root`) is trusted. Every folder from it down
// to the blob folder must be a real directory, never a symlink, checked before each operation; otherwise a planted
// link would make `put` write copies of project files outside storage and `collect` delete files there. A blob is
// read only when it is a regular file of at most `LIMITS.editSourceMaxBytes` (Auto never keeps a larger original),
// opened without following a link or blocking, at most limit + 1 bytes, and only returned when its bytes still hash
// to its name. `collect` only ever unlinks names this module creates (a hash, or `writeFileAtomic`'s temp name for
// one), never anything else and never recursively.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import { isNotFound, writeFileAtomic } from '../storage/json-file';
import { folderCheck, readNoFollow } from './storage-trust';

const HASH = /^[0-9a-f]{64}$/;
/** `writeFileAtomic`'s temp file for a blob: `<hash>.<pid>.<8 hex>.tmp`. */
const TEMP = /^[0-9a-f]{64}\.\d+\.[0-9a-f]{8}\.tmp$/;

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

export interface BlobStore {
  /** Stores `bytes` (owner-only) unless a blob with the same hash exists. Returns the hash. */
  put(bytes: Uint8Array): Promise<string>;
  /**
   * The bytes stored under `hash`, or null when missing, unreadable, not a regular file, over
   * `LIMITS.editSourceMaxBytes` or no longer matching the hash. Never blocks and never reads more than the limit + 1.
   */
  get(hash: string): Promise<Buffer | null>;
  /** Deletes every blob (and stray temp file of one) whose hash isn't in `keep`. Nothing else is touched. */
  collect(keep: ReadonlySet<string>): Promise<void>;
  /** Deletes the whole folder. */
  removeAll(): Promise<void>;
}

/** The blob's bytes when it is intact (a regular file within the limit that hashes to `hash`), else null. */
async function readBlob(file: string, hash: string): Promise<Buffer | null> {
  const got = await readNoFollow(file, LIMITS.editSourceMaxBytes);
  // A damaged blob must never be restored over a project file.
  return got.kind === 'ok' && sha256(got.bytes) === hash ? got.bytes : null;
}

/**
 * @param root the data dir: trusted as it is (it may itself be reached through a link the user chose).
 * @param dir the blob folder; must lie below `root`.
 */
export function createBlobStore(root: string, dir: string): BlobStore {
  // Throws `UnsafeStorageError` before anything is read, written or deleted.
  const checkDirs = folderCheck(root, dir);

  const fileOf = (hash: string): string => {
    if (!HASH.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
    return path.join(dir, hash);
  };

  return {
    async put(bytes) {
      const hash = sha256(bytes);
      const file = fileOf(hash);
      await checkDirs({ create: true });
      if (await readBlob(file, hash).catch(() => null)) return hash;
      // The rename replaces whatever entry has the name (a damaged blob, a link or a FIFO) without following it.
      await writeFileAtomic(file, bytes, 0o600);
      return hash;
    },

    async get(hash) {
      if (!HASH.test(hash)) return null;
      try {
        if ((await checkDirs({ create: false })) === 'missing') return null;
        return await readBlob(fileOf(hash), hash);
      } catch {
        return null;
      }
    },

    async collect(keep) {
      if ((await checkDirs({ create: false })) === 'missing') return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      await Promise.all(
        entries
          .filter((e) => (HASH.test(e.name) && !keep.has(e.name)) || TEMP.test(e.name))
          // `unlink` removes a file or a link itself, never a folder and never a link's target.
          .filter((e) => e.isFile() || e.isSymbolicLink())
          .map((e) => fs.unlink(path.join(dir, e.name)).catch(() => {})),
      );
    },

    async removeAll() {
      // The folders above `dir` must be real, or the recursive removal below would happen somewhere else.
      if ((await checkDirs({ create: false, parentsOnly: true })) === 'missing') return;
      const info = await fs.lstat(dir).catch((err) => {
        if (isNotFound(err)) return null;
        throw err;
      });
      if (info === null) return;
      // A link in the blob folder's place is removed as a link; its target is never touched.
      if (!info.isDirectory() || info.isSymbolicLink()) await fs.unlink(dir);
      else await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
