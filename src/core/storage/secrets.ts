// FileSecretStore: dev / fallback `SecretStore` (plan §3.5, S1.3). Stores secrets in plaintext in a file with
// mode 0600: `{ "version": 1, "<name>": { "enc": "plain", "value": "…" } }`. The Electron `safeStorage`
// implementation lives in S8 (`src/main/safe-storage-secret-store.ts`).

import { CoreError } from '../errors';
import type { SecretStore } from '../types';
import { JsonFile, type StorageLogger } from './json-file';
import { type SecretEntry, secretEntrySchema, secretsFileSchema } from './schemas';

export class FileSecretStore implements SecretStore {
  private readonly file: JsonFile<Record<string, unknown>>;
  private readonly logger?: StorageLogger;

  /** @param filePath absolute path of `secrets.json` (see `dataPaths(dir).secrets`). */
  constructor(filePath: string, opts: { logger?: StorageLogger } = {}) {
    this.logger = opts.logger;
    this.file = new JsonFile(filePath, secretsFileSchema, { mode: 0o600, logger: opts.logger });
  }

  async get(name: string): Promise<string | null> {
    assertName(name);
    const current = await this.file.read();
    if (!current || !Object.hasOwn(current, name)) return null;
    const entry = secretEntrySchema.safeParse(current[name]);
    if (!entry.success) return null;
    if (entry.data.enc !== 'plain') {
      (this.logger ?? console).warn(`Secret "${name}" is encrypted with ${entry.data.enc}; it cannot be read here.`);
      return null;
    }
    return entry.data.value;
  }

  async set(name: string, value: string): Promise<void> {
    assertName(name);
    const entry: SecretEntry = { enc: 'plain', value };
    await this.file.update((current) => ({ ...current, version: 1, [name]: entry }));
  }

  async delete(name: string): Promise<void> {
    assertName(name);
    await this.file.update((current) => {
      const next: Record<string, unknown> = { ...current, version: 1 };
      delete next[name];
      return next;
    });
  }
}

function assertName(name: string): void {
  if (!name || name === 'version') throw new CoreError('invalid_request', `Invalid secret name "${name}".`);
}
