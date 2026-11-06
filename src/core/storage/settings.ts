// SettingsService (plan S1.4): `settings.json` for `lastModel` / `lastEffort`, the API key goes through the
// `SecretStore`.

import type { PublicSettings } from '@shared/types';
import { CoreError } from '../errors';
import type { SecretStore, SettingsService } from '../types';
import { JsonFile, type StorageLogger } from './json-file';
import { type SettingsFile, settingsFileSchema } from './schemas';

/** Name under which the OpenRouter key is kept in the `SecretStore`. */
export const OPENROUTER_SECRET = 'openrouter';

export interface SettingsServiceOptions {
  /** Absolute path of `settings.json`. */
  filePath: string;
  secretStore: SecretStore;
  logger?: StorageLogger;
}

/**
 * First 9 chars + `…` + last 4 (e.g. `sk-or-v1-…a1b2`). Keys too short for that to hide anything show only
 * the tail, or nothing.
 */
export function keyHint(key: string): string {
  if (key.length >= 20) return `${key.slice(0, 9)}…${key.slice(-4)}`;
  return key.length >= 8 ? `…${key.slice(-4)}` : '…';
}

export function createSettingsService(opts: SettingsServiceOptions): SettingsService {
  const file = new JsonFile<SettingsFile>(opts.filePath, settingsFileSchema, { logger: opts.logger });
  const { secretStore } = opts;

  async function snapshot(): Promise<PublicSettings> {
    const [stored, key] = await Promise.all([file.read(), secretStore.get(OPENROUTER_SECRET)]);
    return {
      openRouter: { configured: key !== null && key !== '', keyHint: key ? keyHint(key) : null },
      lastModel: stored?.lastModel ?? null,
      lastEffort: stored?.lastEffort ?? null,
    };
  }

  return {
    get: snapshot,

    async getApiKey() {
      const key = await secretStore.get(OPENROUTER_SECRET);
      return key ? key : null;
    },

    async setApiKey(apiKey) {
      const trimmed = apiKey.trim();
      if (!trimmed) throw new CoreError('invalid_request', 'The API key is empty.');
      await secretStore.set(OPENROUTER_SECRET, trimmed);
      return snapshot();
    },

    async clearApiKey() {
      await secretStore.delete(OPENROUTER_SECRET);
      return snapshot();
    },

    async update(patch) {
      if (patch.lastModel !== undefined || patch.lastEffort !== undefined) {
        await file.update((current) => ({
          version: 1,
          lastModel: patch.lastModel !== undefined ? patch.lastModel : (current?.lastModel ?? null),
          lastEffort: patch.lastEffort !== undefined ? patch.lastEffort : (current?.lastEffort ?? null),
        }));
      }
      return snapshot();
    },
  };
}
