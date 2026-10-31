// Prod `SecretStore` (plan §2, §3.5, S8.4): values are encrypted with Electron `safeStorage` (KWallet / libsecret on
// Linux) and kept base64-encoded in `secrets.json` (mode 0600), same file format as `FileSecretStore`:
//   { "version": 1, "<name>": { "enc": "safeStorage", "value": "<base64 ciphertext>" } }

import { CoreError } from '@core/errors';
import { createFileSecretStore, JsonFile, type StorageLogger } from '@core/storage';
import { dataPaths } from '@core/storage/paths';
import { type SecretEntry, secretEntrySchema, secretsFileSchema } from '@core/storage/schemas';
import type { SecretStore } from '@core/types';

/** The slice of Electron's `safeStorage` we use (injectable for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: `basic_text`, `gnome_libsecret`, `kwallet`, `kwallet5`, `kwallet6`, `unknown`. */
  getSelectedStorageBackend?(): string;
}

export class SafeStorageSecretStore implements SecretStore {
  private readonly file: JsonFile<Record<string, unknown>>;
  private readonly logger: StorageLogger;

  /** @param filePath absolute path of `secrets.json` (see `dataPaths(dir).secrets`). */
  constructor(
    filePath: string,
    private readonly safeStorage: SafeStorageLike,
    opts: { logger?: StorageLogger } = {},
  ) {
    this.logger = opts.logger ?? { warn: (m) => console.warn(`[harness:secrets] ${m}`) };
    this.file = new JsonFile(filePath, secretsFileSchema, { mode: 0o600, logger: this.logger });
  }

  async get(name: string): Promise<string | null> {
    assertName(name);
    const current = await this.file.read();
    if (!current || !Object.hasOwn(current, name)) return null;
    const entry = secretEntrySchema.safeParse(current[name]);
    if (!entry.success) return null;
    // A key saved while safeStorage was unavailable (plain fallback) stays readable; the next `set` re-encrypts it.
    if (entry.data.enc === 'plain') return entry.data.value;
    try {
      return this.safeStorage.decryptString(Buffer.from(entry.data.value, 'base64'));
    } catch (err) {
      this.logger.warn(`Could not decrypt secret "${name}" (${err instanceof Error ? err.message : String(err)}).`);
      return null;
    }
  }

  async set(name: string, value: string): Promise<void> {
    assertName(name);
    const entry: SecretEntry = {
      enc: 'safeStorage',
      value: this.safeStorage.encryptString(value).toString('base64'),
    };
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

/** Linux backends that do not actually protect anything (a hard-coded password): treat as unavailable. */
const WEAK_BACKENDS = new Set(['basic_text', 'unknown']);

/**
 * `SafeStorageSecretStore` when the OS keyring is usable, otherwise the plaintext `FileSecretStore` (logged).
 * Must be called after the Electron `app` is ready.
 */
export function createSecretStore(
  dataDir: string,
  safeStorage: SafeStorageLike,
  logger: { info(m: string): void; warn(m: string): void } = {
    info: (m) => console.log(`[harness:secrets] ${m}`),
    warn: (m) => console.warn(`[harness:secrets] ${m}`),
  },
): SecretStore {
  const backend = safeStorage.getSelectedStorageBackend?.();
  const available = safeStorage.isEncryptionAvailable() && !(backend !== undefined && WEAK_BACKENDS.has(backend));
  if (!available) {
    logger.warn(
      `safeStorage is unavailable (backend: ${backend ?? 'n/a'}); falling back to a plaintext secrets.json (mode 0600).`,
    );
    return createFileSecretStore(dataDir, { logger });
  }
  logger.info(`secrets encrypted with safeStorage (backend: ${backend ?? 'n/a'}).`);
  return new SafeStorageSecretStore(dataPaths(dataDir).secrets, safeStorage, { logger });
}
