// Security middleware for `/api/*` (plan §3.3). The server emits NO CORS headers, so foreign preflights fail.
//
//  1. `Host` must be localhost / 127.0.0.1 (any port) or `harness` (the `app://` host) → blocks DNS rebinding.
//     Checked on the `Host` header when present *and* on the request URL's host (Electron's protocol handler
//     may deliver `app://harness/…` requests without a `Host` header).
//  2. `Origin`, when present, must be one of the app's origins.
//  3. `X-Harness-Client: 1` is required (forces a CORS preflight for any foreign page, which then fails).
//     Exemption: `GET /api/attachments/:id/content` (an `<img src>` cannot set headers) is allowed without the
//     header when the browser says the request is same-origin / user-initiated (`Sec-Fetch-Site: same-origin|none`),
//     or when it arrives through the `app://` protocol handler (not reachable from the network). `same-site`
//     (e.g. another localhost port) and `cross-site` are NOT exempt. Host and Origin checks still apply.

import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@shared/constants';
import type { MiddlewareHandler } from 'hono';
import { errorResponse } from '../http';

const HOST_RE = /^(localhost|127\.0\.0\.1|harness)(:\d{1,5})?$/i;
const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', 'app://harness']);
const CONTENT_PATH_RE = /^\/api\/attachments\/[^/]+\/content$/;

export function isAllowedHost(host: string | null | undefined): boolean {
  return !!host && HOST_RE.test(host);
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export const security: MiddlewareHandler = async (c, next) => {
  const forbidden = (message: string) => errorResponse(c, 'invalid_request', message, 403);

  const url = parseUrl(c.req.url);
  const hostHeader = c.req.header('host');
  if ((hostHeader !== undefined && !isAllowedHost(hostHeader)) || !url || !isAllowedHost(url.host))
    return forbidden('Forbidden: unexpected Host header.');

  const origin = c.req.header('origin');
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) return forbidden('Forbidden: unexpected Origin.');

  if (c.req.header(CLIENT_HEADER) !== CLIENT_HEADER_VALUE) {
    const site = c.req.header('sec-fetch-site');
    const exempt =
      c.req.method === 'GET' &&
      CONTENT_PATH_RE.test(url.pathname) &&
      (site === 'same-origin' || site === 'none' || (site === undefined && url.protocol === 'app:'));
    if (!exempt) return forbidden(`Forbidden: missing ${CLIENT_HEADER} header.`);
  }
  await next();
};
