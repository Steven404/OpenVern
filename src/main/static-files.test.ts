import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSP, mimeFor, resolveInside, serveRenderer } from './static-files';

let root: string;

beforeAll(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'openvern-static-'));
  root = path.join(base, 'renderer');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(path.join(root, 'assets', 'font.woff2'), 'x');
  await writeFile(path.join(base, 'secret.txt'), 'top secret');
});

afterAll(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

const get = (p: string, method = 'GET') => serveRenderer(new Request(`app://openvern${p}`, { method }), root);

describe('serveRenderer', () => {
  it('serves index.html with the CSP at / and falls back to it for SPA routes', async () => {
    for (const p of ['/', '/index.html', '/chat/123']) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('content-security-policy')).toBe(CSP);
      expect(await res.text()).toContain('id="root"');
    }
  });

  it('serves assets with their MIME type and no CSP', async () => {
    const js = await get('/assets/app.js');
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('content-security-policy')).toBeNull();
    expect((await get('/assets/font.woff2')).headers.get('content-type')).toBe('font/woff2');
  });

  it('404s a missing file that has an extension instead of serving HTML', async () => {
    expect((await get('/assets/missing.js')).status).toBe(404);
  });

  it('refuses path traversal in every encoding', async () => {
    for (const p of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/assets/..%5c..%5csecret.txt',
      '/%00',
    ]) {
      const res = await get(p);
      expect([403, 404]).toContain(res.status);
      expect(await res.text()).not.toContain('top secret');
    }
    expect(resolveInside(root, '/%E0%A4%A')).toBeNull(); // malformed escape
  });

  it('only allows GET and HEAD', async () => {
    expect((await get('/', 'POST')).status).toBe(405);
    const head = await get('/', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});

describe('helpers', () => {
  it('mimeFor falls back to octet-stream', () => {
    expect(mimeFor('a.css')).toBe('text/css; charset=utf-8');
    expect(mimeFor('a.unknown')).toBe('application/octet-stream');
  });
  it('resolveInside keeps targets inside the root', () => {
    expect(resolveInside('/r', '/a/b.js')).toBe(path.resolve('/r/a/b.js'));
    expect(resolveInside('/r', '/')).toBe(path.resolve('/r'));
  });
});
