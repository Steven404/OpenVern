// Security middleware tests (S5.2, plan §3.3).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, PNG_BYTES, uploadForm } from './test-helpers';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.cleanup();
});

const raw = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  h.app.request(path, { ...init, headers });
// `app.request('app://…')` would be rewritten to `http://localhost/app://…`; pass a real Request instead.
const viaProtocol = (path: string, headers: Record<string, string> = {}) =>
  h.app.fetch(new Request(`app://harness${path}`, { headers }));
const CLIENT = { 'X-Harness-Client': '1' };

describe('X-Harness-Client', () => {
  it('rejects requests without the header (403)', async () => {
    const res = await raw('/api/health');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('rejects a wrong value', async () => {
    expect((await raw('/api/health', { 'X-Harness-Client': '0' })).status).toBe(403);
  });

  it('also guards unknown /api paths', async () => {
    expect((await raw('/api/nope')).status).toBe(403);
  });

  it('accepts the header', async () => {
    expect((await raw('/api/health', CLIENT)).status).toBe(200);
  });
});

describe('Host', () => {
  it.each(['localhost', 'localhost:5173', '127.0.0.1:8787', 'harness', 'LOCALHOST:1'])(
    'allows Host %s',
    async (host) => {
      expect((await raw('/api/health', { ...CLIENT, Host: host })).status).toBe(200);
    },
  );

  it.each(['evil.com', 'localhost.evil.com', 'evil.com:8787', '127.0.0.1.nip.io', 'localhost@evil.com', ''])(
    'rejects Host %j (DNS rebinding)',
    async (host) => {
      expect((await raw('/api/health', { ...CLIENT, Host: host })).status).toBe(403);
    },
  );

  it('rejects a foreign host in the request URL (no Host header, like the app:// handler)', async () => {
    expect((await raw('http://evil.com/api/health', CLIENT)).status).toBe(403);
  });

  it('allows the app:// URL host', async () => {
    expect((await viaProtocol('/api/health', CLIENT)).status).toBe(200);
  });
});

describe('Origin and CORS', () => {
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173', 'app://harness'])('allows Origin %s', async (origin) => {
    expect((await raw('/api/health', { ...CLIENT, Origin: origin })).status).toBe(200);
  });

  it.each(['https://evil.com', 'http://localhost:3000', 'null', 'http://localhost'])(
    'rejects Origin %s',
    async (origin) => {
      expect((await raw('/api/health', { ...CLIENT, Origin: origin })).status).toBe(403);
    },
  );

  it('emits no CORS headers, and a foreign preflight is refused', async () => {
    const ok = await raw('/api/health', { ...CLIENT, Origin: 'http://localhost:5173' });
    expect([...ok.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);

    const preflight = await raw(
      '/api/chats',
      {
        Origin: 'https://evil.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-harness-client',
      },
      { method: 'OPTIONS' },
    );
    expect(preflight.status).toBe(403);
    expect([...preflight.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });
});

describe('attachment thumbnail exemption (GET /api/attachments/:id/content)', () => {
  async function upload(): Promise<string> {
    const res = await h.call('/api/attachments', { method: 'POST', body: uploadForm(PNG_BYTES, 'x.png', 'image/png') });
    return ((await res.json()) as { id: string }).id;
  }

  it.each(['same-origin', 'none'])('allows Sec-Fetch-Site: %s without the client header', async (site) => {
    const id = await upload();
    const res = await raw(`/api/attachments/${id}/content`, { 'Sec-Fetch-Site': site });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it.each(['cross-site', 'same-site'])('rejects Sec-Fetch-Site: %s', async (site) => {
    const id = await upload();
    expect((await raw(`/api/attachments/${id}/content`, { 'Sec-Fetch-Site': site })).status).toBe(403);
  });

  it('requires the header when Sec-Fetch-Site is absent on http (curl, old clients)', async () => {
    const id = await upload();
    expect((await raw(`/api/attachments/${id}/content`)).status).toBe(403);
  });

  it('allows requests arriving via the app:// protocol handler without Sec-Fetch-Site', async () => {
    const id = await upload();
    expect((await viaProtocol(`/api/attachments/${id}/content`)).status).toBe(200);
  });

  it('still enforces Host and Origin on the exempt route', async () => {
    const id = await upload();
    const same = { 'Sec-Fetch-Site': 'same-origin' };
    expect((await raw(`/api/attachments/${id}/content`, { ...same, Host: 'evil.com' })).status).toBe(403);
    expect((await raw(`/api/attachments/${id}/content`, { ...same, Origin: 'https://evil.com' })).status).toBe(403);
  });

  it('does not extend to other routes or methods', async () => {
    const id = await upload();
    const same = { 'Sec-Fetch-Site': 'same-origin' };
    expect((await raw('/api/chats', same)).status).toBe(403);
    expect((await raw(`/api/attachments/${id}`, same, { method: 'DELETE' })).status).toBe(403);
    expect((await raw(`/api/attachments/${id}/content`, same, { method: 'POST' })).status).toBe(403);
  });
});
