// Content-addressed copies of project files, kept so Undo can restore an Auto turn's originals. One folder per chat
// (`changes/<chatId>.blobs/`), one file per original named by the sha256 of its bytes, shared between that chat's
// batches. Every call must run under the chat's change-store lock: `collect` decides what is unreferenced from the
// store, and a concurrent `put` could otherwise lose a blob it just wrote.
//
// TRUST (invariant): only the data dir itself (`root`) is trusted. Every folder from it down to the blob folder must be
// a real directory, never a symlink, checked before each operation; otherwise a planted link would make `put` write
// copies of project files outside storage and `collect` delete files there. Blobs are opened without following a
// link, and `collect` only ever unlinks names this module creates (a hash, or `writeFileAtomic`'s temp name for one),
// never anything else and never recursively.

import { createHash } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { isNotFound, writeFileAtomic } from '../storage/json-file';

const HASH = /^[0-9a-f]{64}$/;
/** `writeFileAtomic`'s temp file for a blob: `<hash>.<pid>.<8 hex>.tmp`. */
const TEMP = /^[0-9a-f]{64}\.\d+\.[0-9a-f]{8}\.tmp$/;

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

export interface BlobStore {
  /** Stores `bytes` (owner-only) unless a blob with the same hash exists. Returns the hash. */
  put(bytes: Uint8Array): Promise<string>;
  /** The bytes stored under `hash`, or null when missing, unreadable or no longer matching the hash. */
  get(hash: string): Promise<Buffer | null>;
  /** Deletes every blob (and stray temp file of one) whose hash isn't in `keep`. Nothing else is touched. */
  collect(keep: ReadonlySet<string>): Promise<void>;
  /** Deletes the whole folder. */
  removeAll(): Promise<void>;
}

/** Thrown when a folder on the way to the blobs is a symlink or not a directory. Nothing has been touched. */
export class UnsafeBlobDirError extends Error {
  constructor(dir: string) {
    super(`Refusing to use ${dir}: it is a symbolic link or not a folder.`);
    this.name = 'UnsafeBlobDirError';
  }
}

/** A regular file's bytes, opened without following a symlink in its last component. Null when missing. */
async function readNoFollow(file: string): Promise<Buffer | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * @param root the data dir: trusted as it is (it may itself be reached through a link the user chose).
 * @param dir the blob folder; must lie below `root`.
 */
export function createBlobStore(root: string, dir: string): BlobStore {
  const steps = path.relative(root, dir).split(path.sep);
  if (steps.length === 0 || steps.some((s) => s === '' || s === '.' || s === '..') || path.isAbsolute(steps[0] ?? '')) {
    throw new Error(`Blob folder ${dir} is not inside ${root}`);
  }

  const fileOf = (hash: string): string => {
    if (!HASH.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
    return path.join(dir, hash);
  };

  /**
   * Checks every folder from below `root` down to `dir` (or only its first `depth` folders): each must be a real
   * directory (`lstat`, so a symlink is refused). A missing one is created (owner-only) when `create`, and then checked
   * again; otherwise the result is 'missing'. Throws `UnsafeBlobDirError` before anything is read, written or deleted.
   */
  async function checkDirs(create: boolean, depth = steps.length): Promise<'ok' | 'missing'> {
    let cur = root;
    for (const step of steps.slice(0, depth)) {
      cur = path.join(cur, step);
      let info = await fs.lstat(cur).catch((err) => {
        if (isNotFound(err)) return null;
        throw err;
      });
      if (info === null) {
        if (!create) return 'missing';
        // The data dir is owner-only; these are copies of project files, so the folder is too.
        await fs.mkdir(cur, { mode: 0o700 }).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        });
        info = await fs.lstat(cur);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafeBlobDirError(cur);
    }
    return 'ok';
  }

  return {
    async put(bytes) {
      const hash = sha256(bytes);
      const file = fileOf(hash);
      await checkDirs(true);
      const existing = await readNoFollow(file).catch(() => null);
      if (existing && sha256(existing) === hash) return hash;
      // The rename replaces whatever entry has the name (a damaged blob, or a link) without following it.
      await writeFileAtomic(file, bytes, 0o600);
      return hash;
    },

    async get(hash) {
      if (!HASH.test(hash)) return null;
      try {
        if ((await checkDirs(false)) === 'missing') return null;
        const bytes = await readNoFollow(fileOf(hash));
        // A damaged blob must never be restored over a project file.
        return bytes && sha256(bytes) === hash ? bytes : null;
      } catch {
        return null;
      }
    },

    async collect(keep) {
      if ((await checkDirs(false)) === 'missing') return;
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
      if ((await checkDirs(false, steps.length - 1)) === 'missing') return;
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
