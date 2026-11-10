// Prod backend composition (plan §3.2, S8.3/S8.4): the same `createCore` + `createApp` as the dev server, hosted
// in-process behind `protocol.handle('app', …)`.

import path from 'node:path';
import { createCore } from '@core/index';
import { createFakeProvider } from '@core/providers/fake';
import { LEGACY_SLUG, migrateLegacyDataDir, resolveDataDir } from '@core/storage';
import { createApp } from '@server/app';
import { app, safeStorage } from 'electron';
import { shouldMigrateLegacy } from './migration-policy';
import { createSecretStore } from './safe-storage-secret-store';

export interface Backend {
  dataDir: string;
  fetch: (request: Request) => Response | Promise<Response>;
}

/**
 * Data dir: `OPENVERN_DATA_DIR`, else Electron's `userData`, which depends on the mode (startup.ts): `<appData>/openvern`
 * packaged, `<appData>/openvern-dev` for `npm run dev`, `<appData>/openvern-preview` for another unpackaged run, or the
 * `--user-data-dir` switch. `<appData>` is `$XDG_CONFIG_HOME` or `~/.config` on Linux and
 * `~/Library/Application Support` on macOS (so the packaged macOS data dir is `~/Library/Application Support/openvern`).
 * Dev aid: `OPENVERN_FAKE_PROVIDER=1` swaps OpenRouter for the scripted fake provider (no key, no network), also in
 * the packaged app.
 */
export async function createBackend(): Promise<Backend> {
  const userData = app.getPath('userData');
  // 0.1 kept its data in `<config>/harness`; the packaged app's new default is `<config>/openvern` (G0.4).
  // Never on macOS, where 0.1 never shipped; unchanged elsewhere (migration-policy.ts).
  if (shouldMigrateLegacy({ platform: process.platform, dataDirEnv: process.env.OPENVERN_DATA_DIR, userData })) {
    await migrateLegacyDataDir({ dataDir: userData, legacyDir: path.join(path.dirname(userData), LEGACY_SLUG) });
  }
  const dataDir = await resolveDataDir(userData);
  const fake = process.env.OPENVERN_FAKE_PROVIDER === '1';
  const core = await createCore({
    dataDir,
    secretStore: createSecretStore(dataDir, safeStorage),
    provider: fake ? createFakeProvider() : undefined,
    mode: 'prod',
    version: app.getVersion(),
  });
  if (fake) console.log('[openvern] OPENVERN_FAKE_PROVIDER=1: using the fake provider');
  const api = createApp(core, { mode: 'prod', version: app.getVersion() });
  return { dataDir, fetch: (request) => api.fetch(request) };
}
