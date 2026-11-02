// Standalone dev API server on 127.0.0.1:8787 (plan §3.2, S5.7).
// `OPENVERN_DATA_DIR` overrides `./.dev-data`; `OPENVERN_FAKE_PROVIDER=1` swaps OpenRouter for `FakeProvider`.

import { serve } from '@hono/node-server';
import pkg from '../../package.json' with { type: 'json' };
import { createCore } from '../core';
import { createFakeProvider } from '../core/providers/fake';
import { createFileSecretStore, resolveDataDir } from '../core/storage';
import { createApp } from './app';

const HOST = '127.0.0.1';
const PORT = 8787;

const dataDir = await resolveDataDir('./.dev-data');
const fake = process.env.OPENVERN_FAKE_PROVIDER === '1';
const core = await createCore({
  dataDir,
  secretStore: createFileSecretStore(dataDir),
  provider: fake ? createFakeProvider() : undefined,
  mode: 'dev',
  version: pkg.version,
});
const app = createApp(core, { mode: 'dev', version: pkg.version });

/** One log line per request: method, path (no query string), status, ms. Never bodies, headers or keys. */
async function fetchWithLog(request: Request): Promise<Response> {
  const started = performance.now();
  const response = await app.fetch(request);
  const { pathname } = new URL(request.url);
  console.log(`${request.method} ${pathname} ${response.status} ${Math.round(performance.now() - started)}ms`);
  return response;
}

serve({ fetch: fetchWithLog, hostname: HOST, port: PORT }, (info) => {
  console.log(
    `OpenVern dev API on http://${info.address}:${info.port}/api (data: ${dataDir}, provider: ${fake ? 'fake' : 'openrouter'})`,
  );
});
