// Prod `SecretStore` (plan §2, §3.5, S8.4): values are encrypted with Electron `safeStorage` (KWallet / libsecret on
// Linux, the login Keychain on macOS) and kept base64-encoded in `secrets.json` (mode 0600), same file format as
// `FileSecretStore`:
//   { "version": 1, "<name>": { "enc": "safeStorage", "value": "<base64 ciphertext>" } }
// Logs and errors name the secret at most; never its value, its ciphertext, or a raw native error message.

import { getSystemErrorMap } from 'node:util';
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
  /** Linux only: `basic_text`, `gnome_libsecret`, `kwallet`, `kwallet5`, `kwallet6`, `unknown`. Absent on macOS. */
  getSelectedStorageBackend?(): string;
}

export interface SafeStorageSecretStoreOptions {
  logger?: StorageLogger;
  /** Selects platform-accurate wording for errors (defaults to `process.platform`; injectable for tests). */
  platform?: NodeJS.Platform;
}

export class SafeStorageSecretStore implements SecretStore {
  private readonly file: JsonFile<Record<string, unknown>>;
  private readonly logger: StorageLogger;
  private readonly platform: NodeJS.Platform;

  /** @param filePath absolute path of `secrets.json` (see `dataPaths(dir).secrets`). */
  constructor(
    filePath: string,
    private readonly safeStorage: SafeStorageLike,
    opts: SafeStorageSecretStoreOptions = {},
  ) {
    this.logger = opts.logger ?? { warn: (m) => console.warn(`[openvern:secrets] ${m}`) };
    this.platform = opts.platform ?? process.platform;
    this.file = new JsonFile(filePath, secretsFileSchema, { mode: 0o600, logger: this.logger });
  }

  async get(name: string): Promise<string | null> {
    assertName(name);
    const current = await this.file.read();
    if (!current || !Object.hasOwn(current, name)) return null;
    const entry = secretEntrySchema.safeParse(current[name]);
    if (!entry.success) return null;
    // A key saved while safeStorage was unavailable (plain fallback, S8-N1): encrypt it in place now, keep it readable.
    if (entry.data.enc === 'plain') {
      await this.migratePlain(name, entry.data.value);
      return entry.data.value;
    }
    // Read-only: a failed decrypt (Keychain access denied, item deleted, key changed) reports "not configured" and
    // leaves the entry exactly as stored, so a later allowed access can still read it.
    try {
      return this.safeStorage.decryptString(Buffer.from(entry.data.value, 'base64'));
    } catch (err) {
      this.logger.warn(`Could not decrypt secret "${name}"; treating it as not set (${errorLabel(err)}).`);
      return null;
    }
  }

  /**
   * Re-encrypts a plain entry under the file lock (atomic tmp + fsync + rename, mode 0600). Only replaces the entry if
   * it is still the same plain value. On failure the plain entry is left intact. Logs the secret name, never the value.
   */
  private async migratePlain(name: string, plain: string): Promise<void> {
    let migrated = false;
    try {
      await this.file.update((current) => {
        const latest = secretEntrySchema.safeParse(current?.[name]);
        if (!current || !latest.success || latest.data.enc !== 'plain' || latest.data.value !== plain) {
          return current ?? { version: 1 };
        }
        const entry: SecretEntry = {
          enc: 'safeStorage',
          value: this.safeStorage.encryptString(plain).toString('base64'),
        };
        migrated = true;
        return { ...current, version: 1, [name]: entry };
      });
    } catch (err) {
      this.logger.warn(`Could not encrypt plaintext secret "${name}"; leaving it as is (${errorLabel(err)}).`);
      return;
    }
    if (migrated) this.logger.warn(`Migrated plaintext secret "${name}" to safeStorage encryption.`);
  }

  /**
   * Encrypts before touching the file: if `encryptString` throws (Keychain denied or locked, keyring unavailable),
   * rejects with an actionable `internal` error and leaves `secrets.json` untouched. Never falls back to plaintext.
   */
  async set(name: string, value: string): Promise<void> {
    assertName(name);
    let ciphertext: Buffer;
    try {
      ciphertext = this.safeStorage.encryptString(value);
    } catch (err) {
      this.logger.warn(`Could not encrypt secret "${name}"; it was not saved (${errorLabel(err)}).`);
      // No `cause`: the native error is never attached, so it cannot reach server logs or the client.
      throw new CoreError('internal', encryptFailureMessage(this.platform));
    }
    const entry: SecretEntry = { enc: 'safeStorage', value: ciphertext.toString('base64') };
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

/** User-facing, actionable, value-free text for a failed `encryptString` during `set`. */
function encryptFailureMessage(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return (
      'The key was not saved: the macOS Keychain did not allow OpenVern to encrypt it. ' +
      'Unlock your login keychain, choose Allow (or Always Allow) when macOS asks about OpenVern, then try again.'
    );
  }
  if (platform === 'linux') {
    return (
      'The key was not saved: the system keyring (KWallet or GNOME Keyring / libsecret) could not encrypt it. ' +
      'Unlock or start your keyring, then try again.'
    );
  }
  return "The key was not saved: the operating system's credential store could not encrypt it. Try again.";
}

const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'CoreError']);
const SAFE_ERROR_CODES = new Set([...getSystemErrorMap().values()].map(([name]) => name));

/**
 * A value-free label for a thrown error: its standard class name plus a known Node system-error code when present. Never the
 * message, which for native `safeStorage` failures is opaque and could echo input.
 */
function errorLabel(err: unknown): string {
  if (!(err instanceof Error)) return 'non-Error thrown';
  const name = SAFE_ERROR_NAMES.has(err.name) ? err.name : 'Error';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? `${name} ${code}` : name;
}

/** Linux backends that do not actually protect anything (a hard-coded password): treat as unavailable. */
const WEAK_BACKENDS = new Set(['basic_text', 'unknown']);

/** Where `safeStorage` keeps its key, for the startup log. `backend` is only reported by Linux. */
function describeBackend(platform: NodeJS.Platform, backend: string | undefined): string {
  if (platform === 'darwin' && backend === undefined) return 'macOS Keychain';
  return `backend: ${backend ?? 'n/a'}`;
}

export interface CreateSecretStoreOptions {
  /** Defaults to `process.platform`; injectable for tests. */
  platform?: NodeJS.Platform;
}

/**
 * `SafeStorageSecretStore` when the OS keyring is usable, otherwise the plaintext `FileSecretStore` (mode 0600, logged;
 * plan D15, same on macOS and Linux). The choice is made once, here: a later encryption failure never switches to
 * plaintext. Must be called after the Electron `app` is ready.
 */
export function createSecretStore(
  dataDir: string,
  safeStorage: SafeStorageLike,
  logger: { info(m: string): void; warn(m: string): void } = {
    info: (m) => console.log(`[openvern:secrets] ${m}`),
    warn: (m) => console.warn(`[openvern:secrets] ${m}`),
  },
  opts: CreateSecretStoreOptions = {},
): SecretStore {
  const platform = opts.platform ?? process.platform;
  // Optional: Electron only implements it on Linux, so it is normally absent on macOS.
  const backend = safeStorage.getSelectedStorageBackend?.();
  const available = safeStorage.isEncryptionAvailable() && !(backend !== undefined && WEAK_BACKENDS.has(backend));
  const where = describeBackend(platform, backend);
  if (!available) {
    const reason = where === 'macOS Keychain' ? 'the macOS Keychain is not available' : where;
    logger.warn(`safeStorage is unavailable (${reason}); falling back to a plaintext secrets.json (mode 0600).`);
    return createFileSecretStore(dataDir, { logger });
  }
  logger.info(`secrets encrypted with safeStorage (${where}).`);
  return new SafeStorageSecretStore(dataPaths(dataDir).secrets, safeStorage, { logger, platform });
}
