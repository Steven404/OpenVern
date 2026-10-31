// Test helpers for the storage layer (not exported from index.ts).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { SecretStore } from '../types';
import { createStorage, type Storage } from './index';
import type { StorageLogger } from './json-file';

const dirs: string[] = [];

export async function makeTempDir(prefix = 'harness-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Registers cleanup of every temp dir made through `makeTempDir`. Call once at the top of a test file. */
export function cleanupTempDirs(): void {
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });
}

export class MemorySecretStore implements SecretStore {
  readonly data = new Map<string, string>();
  async get(name: string) {
    return this.data.get(name) ?? null;
  }
  async set(name: string, value: string) {
    this.data.set(name, value);
  }
  async delete(name: string) {
    this.data.delete(name);
  }
}

export function recordingLogger(): StorageLogger & { messages: string[] } {
  const messages: string[] = [];
  return { messages, warn: (m) => void messages.push(m) };
}

export async function makeStorage(): Promise<{
  dataDir: string;
  storage: Storage;
  secrets: MemorySecretStore;
  logger: ReturnType<typeof recordingLogger>;
}> {
  const dataDir = path.join(await makeTempDir(), 'data');
  const secrets = new MemorySecretStore();
  const logger = recordingLogger();
  const storage = await createStorage({ dataDir, secretStore: secrets, logger });
  return { dataDir, storage, secrets, logger };
}
