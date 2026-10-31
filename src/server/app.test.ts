// Route tests (S5.8): every non-streaming route's happy path and main errors, against a real core in a temp dir.

import { isApiErrorBody } from '@shared/errors';
import type {
  AttachmentRef,
  Chat,
  ChatSummary,
  ModelInfo,
  Project,
  ProjectListItem,
  PublicSettings,
} from '@shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../core/providers/types';
import { createHarness, type Harness, PNG_BYTES, uploadForm } from './test-helpers';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.cleanup();
});

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body: unknown = await res.json();
  expect(isApiErrorBody(body)).toBe(true);
  expect((body as { error: { code: string } }).error.code).toBe(code);
  return body as { error: { code: string; message: string } };
}

describe('health, errors, 404', () => {
  it('GET /api/health', async () => {
    const res = await h.call('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '9.9.9', mode: 'dev' });
  });

  it('unknown /api route is 404 not_found', async () => {
    await expectError(await h.call('/api/nope'), 404, 'not_found');
  });

  it('malformed JSON and schema failures are 400 invalid_request with a helpful message', async () => {
    const bad = await h.call('/api/projects', {
      method: 'POST',
      body: '{nope',
      headers: { 'content-type': 'application/json' },
    });
    expect((await expectError(bad, 400, 'invalid_request')).error.message).toMatch(/JSON/);
    const wrong = await h.call('/api/projects', { method: 'POST', json: { rootPath: 5 } });
    expect((await expectError(wrong, 400, 'invalid_request')).error.message).toMatch(/rootPath/);
  });

  it('unexpected errors become 500 internal without leaking details', async () => {
    h.core.settings.get = async () => {
      throw new Error('secret stack detail /home/x/y.ts');
    };
    const res = await h.call('/api/settings');
    const body = await expectError(res, 500, 'internal');
    expect(JSON.stringify(body)).not.toMatch(/secret stack detail|\.ts/);
  });
});

describe('settings and models', () => {
  it('GET/PATCH /api/settings', async () => {
    const initial = (await (await h.call('/api/settings')).json()) as PublicSettings;
    expect(initial).toEqual({ openRouter: { configured: false, keyHint: null }, lastModel: null });
    const res = await h.call('/api/settings', { method: 'PATCH', json: { lastModel: 'openai/gpt-5.5' } });
    expect(((await res.json()) as PublicSettings).lastModel).toBe('openai/gpt-5.5');
  });

  it('PUT /api/settings/openrouter-key validates, stores and masks; DELETE clears', async () => {
    const bad = await h.call('/api/settings/openrouter-key', { method: 'PUT', json: { apiKey: 'nope' } });
    await expectError(bad, 400, 'invalid_api_key');
    expect(((await (await h.call('/api/settings')).json()) as PublicSettings).openRouter.configured).toBe(false);

    const ok = await h.call('/api/settings/openrouter-key', { method: 'PUT', json: { apiKey: 'sk-or-v1-abcdef1234' } });
    expect(ok.status).toBe(200);
    const settings = (await ok.json()) as PublicSettings;
    expect(settings.openRouter.configured).toBe(true);
    expect(settings.openRouter.keyHint).toMatch(/1234$/);
    expect(JSON.stringify(settings)).not.toContain('sk-or-v1-abcdef1234');

    const del = (await (await h.call('/api/settings/openrouter-key', { method: 'DELETE' })).json()) as PublicSettings;
    expect(del.openRouter).toEqual({ configured: false, keyHint: null });
  });

  it('maps provider failures while validating the key (network_error → 502)', async () => {
    h.provider.validateKey = async () => {
      throw new ProviderError('network_error', 'down', true);
    };
    await expectError(
      await h.call('/api/settings/openrouter-key', { method: 'PUT', json: { apiKey: 'sk-or-x' } }),
      502,
      'network_error',
    );
  });

  it('GET /api/models lists models; no_api_key → 400', async () => {
    const res = await h.call('/api/models?refresh=1');
    const models = (await res.json()) as ModelInfo[];
    expect(models.length).toBeGreaterThan(0);

    const noKey = await createHarness({
      wrapProvider: (fake) => ({
        ...fake,
        id: 'fake',
        listModels: async () => {
          throw new ProviderError('no_api_key', 'Add your OpenRouter API key in Settings to start chatting.');
        },
        validateKey: fake.validateKey,
        stream: fake.stream,
      }),
    });
    try {
      await expectError(await noKey.call('/api/models'), 400, 'no_api_key');
    } finally {
      await noKey.cleanup();
    }
  });
});

describe('projects', () => {
  it('create / list (sorted) / rename / delete', async () => {
    const created = await h.call('/api/projects', { method: 'POST', json: { rootPath: h.projectDir, name: 'zeta' } });
    expect(created.status).toBe(200);
    const project = (await created.json()) as Project;
    expect(project.name).toBe('zeta');

    const other = await createHarness();
    try {
      await h.call('/api/projects', { method: 'POST', json: { rootPath: other.projectDir, name: 'Alpha' } });
    } finally {
      await other.cleanup();
    }
    const list = (await (await h.call('/api/projects')).json()) as ProjectListItem[];
    expect(list.map((p) => p.name)).toEqual(['Alpha', 'zeta']);
    expect(list[0]?.chatCount).toBe(0);

    const renamed = await h.call(`/api/projects/${project.id}`, { method: 'PATCH', json: { name: 'Renamed' } });
    expect(((await renamed.json()) as Project).name).toBe('Renamed');

    const del = await h.call(`/api/projects/${project.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(((await (await h.call('/api/projects')).json()) as Project[]).map((p) => p.id)).not.toContain(project.id);
  });

  it('errors: path_invalid 400, conflict 409, rename unknown 404', async () => {
    await expectError(
      await h.call('/api/projects', { method: 'POST', json: { rootPath: '/definitely/not/here' } }),
      400,
      'path_invalid',
    );
    await h.call('/api/projects', { method: 'POST', json: { rootPath: h.projectDir } });
    await expectError(
      await h.call('/api/projects', { method: 'POST', json: { rootPath: h.projectDir } }),
      409,
      'conflict',
    );
    await expectError(await h.call('/api/projects/nope', { method: 'PATCH', json: { name: 'x' } }), 404, 'not_found');
  });

  it('deleting a project turns its chats into loose chats', async () => {
    const project = (await (
      await h.call('/api/projects', { method: 'POST', json: { rootPath: h.projectDir } })
    ).json()) as Project;
    const chat = (await (
      await h.call('/api/chats', { method: 'POST', json: { projectId: project.id, model: 'm' } })
    ).json()) as Chat;
    await h.call(`/api/projects/${project.id}`, { method: 'DELETE' });
    expect(((await (await h.call(`/api/chats/${chat.id}`)).json()) as Chat).projectId).toBeNull();
  });
});

describe('chats', () => {
  it('create / get / patch / list / delete', async () => {
    const created = await h.call('/api/chats', { method: 'POST', json: { projectId: null, model: 'openai/gpt-5.5' } });
    expect(created.status).toBe(200);
    const chat = (await created.json()) as Chat;
    expect(chat).toMatchObject({ title: 'New chat', messages: [], projectId: null, model: 'openai/gpt-5.5' });

    expect(((await (await h.call(`/api/chats/${chat.id}`)).json()) as Chat).id).toBe(chat.id);

    const patched = await h.call(`/api/chats/${chat.id}`, { method: 'PATCH', json: { title: 'Renamed' } });
    expect(((await patched.json()) as ChatSummary).title).toBe('Renamed');

    expect(((await (await h.call('/api/chats')).json()) as ChatSummary[]).map((c) => c.id)).toEqual([chat.id]);

    expect((await h.call(`/api/chats/${chat.id}`, { method: 'DELETE' })).status).toBe(204);
    await expectError(await h.call(`/api/chats/${chat.id}`), 404, 'not_found');
  });

  it('errors: unknown chat 404; create with unknown project 404; bad body 400', async () => {
    await expectError(await h.call('/api/chats/nope'), 404, 'not_found');
    await expectError(await h.call('/api/chats/nope', { method: 'DELETE' }), 404, 'not_found');
    await expectError(
      await h.call('/api/chats', { method: 'POST', json: { projectId: 'nope', model: 'm' } }),
      404,
      'not_found',
    );
    await expectError(await h.call('/api/chats', { method: 'POST', json: { model: 'm' } }), 400, 'invalid_request');
  });
});

describe('attachments', () => {
  it('uploads a text file and serves it back with safe headers', async () => {
    const res = await h.call('/api/attachments', { method: 'POST', body: uploadForm('hello world', 'notes.md') });
    expect(res.status).toBe(200);
    const ref = (await res.json()) as AttachmentRef;
    expect(ref).toMatchObject({ name: 'notes.md', kind: 'text', mime: 'text/markdown', size: 11 });

    const content = await h.call(`/api/attachments/${ref.id}/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('hello world');
    expect(content.headers.get('content-type')).toContain('text/markdown');
    expect(content.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('uploads an image with its sniffed mime', async () => {
    const res = await h.call('/api/attachments', { method: 'POST', body: uploadForm(PNG_BYTES, 'x.png', 'image/png') });
    const ref = (await res.json()) as AttachmentRef;
    expect(ref).toMatchObject({ kind: 'image', mime: 'image/png' });
    const content = await h.call(`/api/attachments/${ref.id}/content`);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('415 for binary files, 400 without a file field', async () => {
    const binary = new Uint8Array([1, 2, 0, 3, 4]);
    await expectError(
      await h.call('/api/attachments', { method: 'POST', body: uploadForm(binary, 'a.bin') }),
      415,
      'unsupported_file',
    );
    const form = new FormData();
    form.append('other', 'x');
    await expectError(await h.call('/api/attachments', { method: 'POST', body: form }), 400, 'invalid_request');
    await expectError(await h.call('/api/attachments', { method: 'POST', json: { file: 1 } }), 400, 'invalid_request');
  });

  it('413 when the declared size is over the largest limit (no buffering) and for oversized text', async () => {
    const huge = await h.call('/api/attachments', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(50 * 1024 * 1024) },
      body: 'irrelevant',
    });
    await expectError(huge, 413, 'file_too_large');

    const bigText = 'a'.repeat(600 * 1024);
    await expectError(
      await h.call('/api/attachments', { method: 'POST', body: uploadForm(bigText, 'big.txt') }),
      413,
      'file_too_large',
    );
  });

  it('413 for a streamed body without Content-Length that exceeds the limit', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 12) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const res = await h.app.request('/api/attachments', {
      method: 'POST',
      headers: { 'x-harness-client': '1', 'content-type': 'multipart/form-data; boundary=x' },
      body,
      duplex: 'half',
    });
    await expectError(res, 413, 'file_too_large');
  });

  it('DELETE removes an unbound attachment (204) and 404s for unknown ids', async () => {
    const ref = (await (
      await h.call('/api/attachments', { method: 'POST', body: uploadForm('x', 'a.txt') })
    ).json()) as AttachmentRef;
    expect((await h.call(`/api/attachments/${ref.id}`, { method: 'DELETE' })).status).toBe(204);
    await expectError(await h.call(`/api/attachments/${ref.id}/content`), 404, 'not_found');
    await expectError(await h.call('/api/attachments/nope', { method: 'DELETE' }), 404, 'not_found');
  });

  it('DELETE of an attachment bound to a message is 409', async () => {
    const chat = (await (
      await h.call('/api/chats', { method: 'POST', json: { projectId: null, model: 'openai/gpt-5.5' } })
    ).json()) as Chat;
    const ref = (await (
      await h.call('/api/attachments', { method: 'POST', body: uploadForm('x', 'a.txt') })
    ).json()) as AttachmentRef;
    await h.core.attachments.bindToChat([ref.id], chat.id);
    await expectError(await h.call(`/api/attachments/${ref.id}`, { method: 'DELETE' }), 409, 'conflict');
  });

  it('deleting a chat removes its attachments', async () => {
    const chat = (await (
      await h.call('/api/chats', { method: 'POST', json: { projectId: null, model: 'openai/gpt-5.5' } })
    ).json()) as Chat;
    const ref = (await (
      await h.call('/api/attachments', { method: 'POST', body: uploadForm('x', 'a.txt') })
    ).json()) as AttachmentRef;
    await h.core.attachments.bindToChat([ref.id], chat.id);
    expect((await h.call(`/api/chats/${chat.id}`, { method: 'DELETE' })).status).toBe(204);
    await expectError(await h.call(`/api/attachments/${ref.id}/content`), 404, 'not_found');
  });
});
