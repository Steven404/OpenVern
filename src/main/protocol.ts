// The `app://harness/` origin in prod (plan §3.2/§3.3, S8.3): `/api/*` → the Hono app, everything else → the built
// renderer files. Streaming works through `protocol.handle` (S8.1, plan §10): the `Response` is returned untouched.

import { API_PREFIX } from '@shared/api';
import { protocol } from 'electron';
import { PROD_ORIGIN } from './origin';
import { serveRenderer } from './static-files';

export const APP_SCHEME = 'app';
const APP_HOST = new URL(PROD_ORIGIN).host;

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

export interface AppProtocolOptions {
  /** `createApp(core, …).fetch`. */
  fetchApi: (request: Request) => Response | Promise<Response>;
  /** Absolute path of the built renderer (`out/renderer`). */
  rendererDir: string;
}

export function handleAppProtocol({ fetchApi, rendererDir }: AppProtocolOptions): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Forbidden', { status: 403 });
    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) return fetchApi(request);
    return serveRenderer(request, rendererDir);
  });
}
