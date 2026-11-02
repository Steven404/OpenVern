// Prod backend composition (plan §3.2, S8.3/S8.4): the same `createCore` + `createApp` as the dev server, hosted
// in-process behind `protocol.handle('app', …)`.

import path from 'node:path';
import { createCore } from '@core/index';
import { createFakeProvider } from '@core/providers/fake';
import { LEGACY_SLUG, migrateLegacyDataDir, resolveDataDir } from '@core/storage';
import { createApp } from '@server/app';
import { APP_SLUG } from '@shared/constants';
import { app, safeStorage } from 'electron';
import { createSecretStore } from './safe-storage-secret-store';

export interface Backend {
  dataDir: string;
  fetch: (request: Request) => Response | Promise<Response>;
}

/**
 * Data dir: `OPENVERN_DATA_DIR`, else Electron's `userData`, which depends on the mode (startup.ts): `~/.config/openvern`
 * packaged, `~/.config/openvern-preview` for an unpackaged non-dev run, or the `--user-data-dir` switch.
 * Dev aid: `OPENVERN_FAKE_PROVIDER=1` swaps OpenRouter for the scripted fake provider (no key, no network), also in
 * the packaged app.
 */
export async function createBackend(): Promise<Backend> {
  const userData = app.getPath('userData');
  // 0.1 kept its data in `<config>/harness`; the packaged app's new default is `<config>/openvern` (G0.4).
  if (!process.env.OPENVERN_DATA_DIR?.trim() && path.basename(userData) === APP_SLUG) {
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
