// Prod backend composition (plan §3.2, S8.3/S8.4): the same `createCore` + `createApp` as the dev server, hosted
// in-process behind `protocol.handle('app', …)`.

import { createCore } from '@core/index';
import { createFakeProvider } from '@core/providers/fake';
import { resolveDataDir } from '@core/storage';
import { createApp } from '@server/app';
import { app, safeStorage } from 'electron';
import { createSecretStore } from './safe-storage-secret-store';

export interface Backend {
  dataDir: string;
  fetch: (request: Request) => Response | Promise<Response>;
}

/**
 * Data dir: `HARNESS_DATA_DIR`, else Electron's `userData`, which depends on the mode (startup.ts): `~/.config/harness`
 * packaged, `~/.config/harness-preview` for an unpackaged non-dev run, or the `--user-data-dir` switch.
 * Dev aid: `HARNESS_FAKE_PROVIDER=1` swaps OpenRouter for the scripted fake provider (no key, no network), also in
 * the packaged app.
 */
export async function createBackend(): Promise<Backend> {
  const dataDir = await resolveDataDir(app.getPath('userData'));
  const fake = process.env.HARNESS_FAKE_PROVIDER === '1';
  const core = await createCore({
    dataDir,
    secretStore: createSecretStore(dataDir, safeStorage),
    provider: fake ? createFakeProvider() : undefined,
    mode: 'prod',
  });
  if (fake) console.log('[harness] HARNESS_FAKE_PROVIDER=1: using the fake provider');
  const api = createApp(core, { mode: 'prod', version: app.getVersion() });
  return { dataDir, fetch: (request) => api.fetch(request) };
}
