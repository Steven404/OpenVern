// Typed JSON files: schema-validated reads, atomic writes (tmp + fsync + rename), per-file mutex, and
// corrupt-file recovery (plan §3.5, S1.2).

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { withFileLock } from './mutex';

export interface StorageLogger {
  warn(message: string): void;
}

export const consoleLogger: StorageLogger = { warn: (m) => console.warn(`[openvern:storage] ${m}`) };

export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Writes `data` to `file` atomically: a unique `*.tmp` sibling is written and fsynced, then renamed over the target.
 * Readers see either the old or the new content, never a partial file. Does not take the file lock.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const handle = await fs.open(tmp, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export interface JsonFileOptions {
  /** File mode for new content. Default 0o644; use 0o600 for secrets. */
  mode?: number;
  logger?: StorageLogger;
}

/** `T` is what reads return; `W` is what writes accept (differs when the schema strips/adds fields). */
export class JsonFile<T, W = T> {
  private readonly mode: number;
  private readonly logger: StorageLogger;

  constructor(
    readonly path: string,
    private readonly schema: z.ZodType<T>,
    opts: JsonFileOptions = {},
  ) {
    this.mode = opts.mode ?? 0o644;
    this.logger = opts.logger ?? consoleLogger;
  }

  /** Returns the validated content, or `null` if the file is missing or was corrupt (then backed up). */
  read(): Promise<T | null> {
    return withFileLock(this.path, () => this.readUnlocked());
  }

  /** Atomically replaces the content. */
  write(value: W): Promise<void> {
    return withFileLock(this.path, () => this.writeUnlocked(value));
  }

  /** Read-modify-write under the file lock. */
  update(fn: (current: T | null) => W | Promise<W>): Promise<W> {
    return withFileLock(this.path, async () => {
      const next = await fn(await this.readUnlocked());
      await this.writeUnlocked(next);
      return next;
    });
  }

  /** Deletes the file. Returns false if it did not exist. */
  delete(): Promise<boolean> {
    return withFileLock(this.path, async () => {
      try {
        await fs.unlink(this.path);
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    });
  }

  private async readUnlocked(): Promise<T | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    let reason: string;
    try {
      const parsed = this.schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      reason = parsed.error.issues[0]?.message ?? 'schema mismatch';
    } catch (err) {
      reason = err instanceof Error ? err.message : 'invalid JSON';
    }
    await this.quarantine(reason);
    return null;
  }

  private async quarantine(reason: string): Promise<void> {
    const backup = `${this.path}.corrupt-${Date.now()}`;
    try {
      await fs.rename(this.path, backup);
      this.logger.warn(`${path.basename(this.path)} is corrupt (${reason}); moved to ${path.basename(backup)}.`);
    } catch (err) {
      this.logger.warn(`${path.basename(this.path)} is corrupt (${reason}) and could not be backed up: ${String(err)}`);
    }
  }

  private writeUnlocked(value: W): Promise<void> {
    return writeFileAtomic(this.path, `${JSON.stringify(value, null, 2)}\n`, this.mode);
  }
}
