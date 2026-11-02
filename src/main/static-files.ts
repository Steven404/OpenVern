// Serves the built renderer (`out/renderer/`) for the `app://openvern/` origin (plan §3.3, S8.3).
// Pure Node + Web APIs (no Electron import) so it is unit-testable.

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** CSP sent with every HTML response (plan S8.3, verbatim). */
export const CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; script-src 'self'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra } });
}

/**
 * Maps a URL pathname to a file strictly inside `root`, or `null` when it would escape it (`..`, encoded
 * separators, NUL bytes, backslashes) or cannot be decoded.
 */
export function resolveInside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded.split('/').includes('..')) return null;
  const target = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

async function readFileIfExists(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? await fs.readFile(file) : null;
  } catch {
    return null;
  }
}

/**
 * GET/HEAD only. Existing files are served with their MIME type; a missing path *without* a file extension falls
 * back to `index.html` (SPA); a missing path with an extension is a 404 (so a broken asset URL is not HTML).
 */
export async function serveRenderer(request: Request, root: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(405, 'Method not allowed', { allow: 'GET, HEAD' });
  }
  const { pathname } = new URL(request.url);
  const target = resolveInside(root, pathname);
  if (!target) return text(403, 'Forbidden');

  let file = target;
  let body = await readFileIfExists(file);
  if (!body && path.extname(pathname) === '') {
    file = path.join(root, 'index.html');
    body = await readFileIfExists(file);
  }
  if (!body) return text(404, 'Not found');

  const isHtml = path.extname(file).toLowerCase() === '.html';
  const headers: Record<string, string> = {
    'content-type': mimeFor(file),
    'x-content-type-options': 'nosniff',
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
  };
  if (isHtml) headers['content-security-policy'] = CSP;
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers });
}
