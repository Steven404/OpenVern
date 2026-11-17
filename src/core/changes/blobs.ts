// Content-addressed copies of project files, kept so Undo can restore an Auto turn's originals. One folder per chat
// (`changes/<chatId>.blobs/`), one file per original named by the sha256 of its bytes, shared between that chat's
// batches. Every call must run under the chat's change-store lock: `collect` decides what is unreferenced from the
// store, and a concurrent `put` could otherwise lose a blob it just wrote.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isNotFound, writeFileAtomic } from '../storage/json-file';

const HASH = /^[0-9a-f]{64}$/;

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

export interface BlobStore {
  /** Stores `bytes` (owner-only) unless a blob with the same hash exists. Returns the hash. */
  put(bytes: Uint8Array): Promise<string>;
  /** The bytes stored under `hash`, or null when missing or no longer matching the hash. */
  get(hash: string): Promise<Buffer | null>;
  /** Deletes every blob (and stray temp file) whose hash isn't in `keep`. */
  collect(keep: ReadonlySet<string>): Promise<void>;
  /** Deletes the whole folder. */
  removeAll(): Promise<void>;
}

export function createBlobStore(dir: string): BlobStore {
  const fileOf = (hash: string): string => {
    if (!HASH.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
    return path.join(dir, hash);
  };

  return {
    async put(bytes) {
      const hash = sha256(bytes);
      const file = fileOf(hash);
      const existing = await fs.readFile(file).catch(() => null);
      if (existing && sha256(existing) === hash) return hash;
      // The data dir is owner-only; these are copies of project files, so the folder and files are too.
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(file, bytes, 0o600);
      return hash;
    },

    async get(hash) {
      if (!HASH.test(hash)) return null;
      const bytes = await fs.readFile(fileOf(hash)).catch(() => null);
      // A damaged blob must never be restored over a project file.
      return bytes && sha256(bytes) === hash ? bytes : null;
    },

    async collect(keep) {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
      await Promise.all(
        names
          .filter((name) => !keep.has(name))
          .map((name) => fs.rm(path.join(dir, name), { force: true, recursive: true }).catch(() => {})),
      );
    },

    async removeAll() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
