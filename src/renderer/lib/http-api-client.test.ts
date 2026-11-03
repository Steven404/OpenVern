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
    expect(headers.get('X-OpenVern-Client')).toBe('1');
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

  describe('stream failures after the response starts', () => {
    const sse = (pull: (c: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>) =>
      new Response(new ReadableStream<Uint8Array>({ pull }), { headers: { 'Content-Type': 'text/event-stream' } });
    const enc = new TextEncoder();
    const drain = async (api: HttpApiClient, signal = new AbortController().signal) => {
      for await (const _ of api.retry('c1', { model: 'x' }, signal)) {
        // drain
      }
    };

    it('maps a body error partway through to network_error', async () => {
      let n = 0;
      const api = new HttpApiClient('/api', (async () =>
        sse((c) => {
          if (n++ === 0) c.enqueue(enc.encode('data: {"type":"done"}\n\n'));
          else c.error(new TypeError('network error'));
        })) as typeof fetch);
      const err = await drain(api).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ info: { code: 'network_error', retryable: true } });
    });

    it('maps a garbled frame to network_error', async () => {
      const api = new HttpApiClient('/api', (async () =>
        sse((c) => {
          c.enqueue(enc.encode('data: {"type":"te\n\n'));
          c.close();
        })) as typeof fetch);
      const err = await drain(api).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ info: { code: 'network_error' } });
    });

    it('still rejects with AbortError when aborted mid-stream', async () => {
      const ctrl = new AbortController();
      const api = new HttpApiClient('/api', (async () =>
        sse((c) => {
          c.enqueue(enc.encode('data: {"type":"done"}\n\n'));
          ctrl.abort();
          c.error(new DOMException('aborted', 'AbortError'));
        })) as typeof fetch);
      const err = await drain(api, ctrl.signal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DOMException);
      expect(err).toMatchObject({ name: 'AbortError' });
    });
  });

  it('builds attachment URLs', () => {
    expect(new HttpApiClient().attachmentUrl('a 1')).toBe('/api/attachments/a%201/content');
  });

  describe('v0.2 project files and changes', () => {
    const calls = async (fn: (api: HttpApiClient) => Promise<unknown>) => {
      const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => json({}));
      await fn(new HttpApiClient('/api', fetchMock as typeof fetch));
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      return { url, init };
    };

    it('lists and reads project files with encoded paths', async () => {
      expect((await calls((a) => a.listProjectFiles('p 1'))).url).toBe('/api/projects/p%201/files');
      const r = await calls((a) => a.readProjectFile('p1', 'src/a b.ts'));
      expect(r.url).toBe('/api/projects/p1/files/content?path=src%2Fa%20b.ts');
      expect(r.init?.method).toBe('GET');
    });

    it('lists and reads the home directory', async () => {
      expect((await calls((a) => a.listHomeFiles())).url).toBe('/api/home/files');
      const r = await calls((a) => a.readHomeFile('Docs/a b.txt'));
      expect(r.url).toBe('/api/home/files/content?path=Docs%2Fa%20b.txt');
      const att = await calls((a) => a.attachHomeFile('note.txt'));
      expect(att.url).toBe('/api/home/files/attach');
      expect(att.init?.method).toBe('POST');
      expect(att.init?.body).toBe('{"path":"note.txt"}');
    });

    it('attaches a project file', async () => {
      const { url, init } = await calls((a) => a.attachProjectFile('p1', 'a.png'));
      expect(url).toBe('/api/projects/p1/files/attach');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe('{"path":"a.png"}');
    });

    it('gets, applies and discards chat changes', async () => {
      expect((await calls((a) => a.getChatChanges('c1'))).url).toBe('/api/chats/c1/changes');
      const apply = await calls((a) =>
        a.applyChatChanges('c1', { revision: 2, decisions: { 'a.ts': { h: 'accepted' } } }),
      );
      expect(apply.url).toBe('/api/chats/c1/changes/apply');
      expect(apply.init?.method).toBe('POST');
      expect(apply.init?.body).toBe('{"revision":2,"decisions":{"a.ts":{"h":"accepted"}}}');
      const del = await calls((a) => a.discardChatChanges('c1'));
      expect(del.url).toBe('/api/chats/c1/changes');
      expect(del.init?.method).toBe('DELETE');
    });
  });
});
