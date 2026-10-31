import type { AgentEvent } from '@shared/events';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-client';
import { HttpApiClient } from './http-api-client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('HttpApiClient', () => {
  it('sends the client header and JSON bodies', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json({ id: 'p1', name: 'x', rootPath: '/x', createdAt: '' }),
    );
    const api = new HttpApiClient('/api', fetchMock as typeof fetch);
    await api.createProject({ rootPath: '/x' });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/projects');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('X-Harness-Client')).toBe('1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe('{"rootPath":"/x"}');
  });

  it('turns error bodies into ApiError', async () => {
    const api = new HttpApiClient('/api', (async () =>
      json({ error: { code: 'path_invalid', message: 'Nope.', retryable: false } }, 400)) as typeof fetch);
    const err = await api.createProject({ rootPath: 'rel' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, info: { code: 'path_invalid', message: 'Nope.' } });
  });

  it('maps fetch failures to network_error', async () => {
    const api = new HttpApiClient('/api', (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    await expect(api.listChats()).rejects.toMatchObject({ info: { code: 'network_error', retryable: true } });
  });

  it('returns nothing for 204', async () => {
    const api = new HttpApiClient('/api', (async () => new Response(null, { status: 204 })) as typeof fetch);
    await expect(api.deleteChat('c1')).resolves.toBeUndefined();
  });

  it('streams AgentEvents from SSE', async () => {
    const events: AgentEvent[] = [
      { type: 'assistant_start', messageId: 'm1', model: 'x' },
      { type: 'text_delta', messageId: 'm1', delta: 'hi' },
      { type: 'done' },
    ];
    const body = `: keepalive\n\n${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}`;
    const api = new HttpApiClient(
      '/api',
      (async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch,
    );
    const out: AgentEvent[] = [];
    for await (const e of api.retry('c1', { model: 'x' }, new AbortController().signal)) out.push(e);
    expect(out).toEqual(events);
  });

  it('builds attachment URLs', () => {
    expect(new HttpApiClient().attachmentUrl('a 1')).toBe('/api/attachments/a%201/content');
  });
});
