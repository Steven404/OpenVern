// v0.2 routes (plan §4.3, G3.5): project files, attach, and the chat change-set lifecycle. Uses the in-memory
// `ChangesService` fake from the harness.

import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '@shared/events';
import type {
  AttachmentRef,
  Chat,
  ChatChanges,
  HomeFileTree,
  PendingChanges,
  Project,
  ProjectFileContent,
  ProjectFileTree,
} from '@shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentService } from '../core/types';
import { collectEvents, createHarness, type Harness, PNG_BYTES } from './test-helpers';

const MODEL = 'anthropic/claude-sonnet-5.5';
let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await mkdir(path.join(h.projectDir, 'src'), { recursive: true });
  await writeFile(path.join(h.projectDir, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(h.projectDir, '.env'), 'SECRET=1\n');
  await writeFile(path.join(h.projectDir, 'logo.png'), PNG_BYTES);
});
afterEach(async () => {
  await h.cleanup();
});

const json = async <T>(res: Response) => (await res.json()) as T;
const newProject = async () =>
  json<Project>(await h.call('/api/projects', { method: 'POST', json: { rootPath: h.projectDir } }));
const newChat = async (projectId: string | null) =>
  json<Chat>(await h.call('/api/chats', { method: 'POST', json: { projectId, model: MODEL } }));
const pending = (revision = 1): PendingChanges => ({
  revision,
  messageId: 'm1',
  files: [
    {
      path: 'src/a.ts',
      kind: 'modify',
      add: 1,
      del: 1,
      hunks: [
        { id: '1:abcdef12', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '', lines: ['-a', '+b'] },
      ],
    },
  ],
  totalAdd: 1,
  totalDel: 1,
});

describe('client header', () => {
  it.each([
    ['GET', '/api/projects/x/files'],
    ['GET', '/api/projects/x/files/content?path=a'],
    ['POST', '/api/projects/x/files/attach'],
    ['GET', '/api/home/files'],
    ['GET', '/api/home/files/content?path=a'],
    ['POST', '/api/home/files/attach'],
    ['GET', '/api/chats/x/changes'],
    ['DELETE', '/api/chats/x/changes'],
    ['POST', '/api/chats/x/changes/apply'],
  ])('%s %s requires X-OpenVern-Client', async (method, url) => {
    expect((await h.app.request(url, { method })).status).toBe(403);
  });
});

describe('project files', () => {
  it('lists the tree without secrets, dirs first', async () => {
    const p = await newProject();
    const tree = await json<ProjectFileTree>(await h.call(`/api/projects/${p.id}/files`));
    expect(tree.truncated).toBe(false);
    expect(tree.entries).toEqual([
      { path: 'src', type: 'dir' },
      { path: 'src/a.ts', type: 'file' },
      { path: 'logo.png', type: 'file' },
      { path: 'README.md', type: 'file' },
    ]);
  });

  it('reads a file', async () => {
    const p = await newProject();
    const res = await h.call(`/api/projects/${p.id}/files/content?path=src/a.ts`);
    expect(await res.json()).toMatchObject({
      path: 'src/a.ts',
      content: 'export const a = 1;\n',
      totalLines: 1,
      binary: false,
      truncated: false,
    });
    const bin = await json<{ binary: boolean; content: null }>(
      await h.call(`/api/projects/${p.id}/files/content?path=logo.png`),
    );
    expect(bin).toMatchObject({ binary: true, content: null });
  });

  it('refuses traversal, absolute paths, denied files and symlink escapes', async () => {
    const p = await newProject();
    await symlink('/etc/hostname', path.join(h.projectDir, 'link'));
    for (const bad of ['../x', '/etc/passwd', `${h.projectDir}/../x`, '.env', 'link', '.git/config']) {
      const res = await h.call(`/api/projects/${p.id}/files/content?path=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
    }
    expect((await h.call(`/api/projects/${p.id}/files/content`)).status).toBe(400);
    expect((await h.call(`/api/projects/${p.id}/files/content?path=nope.txt`)).status).toBe(404);
    expect((await h.call(`/api/projects/${p.id}/files/content?path=src`)).status).toBe(400);
    const attach = await h.call(`/api/projects/${p.id}/files/attach`, { method: 'POST', json: { path: '../x' } });
    expect(attach.status).toBe(400);
    expect((await h.call('/api/projects/nope/files')).status).toBe(404);
  });

  it('attaches text and images through the upload limits', async () => {
    const p = await newProject();
    const att = await json<AttachmentRef>(
      await h.call(`/api/projects/${p.id}/files/attach`, { method: 'POST', json: { path: 'README.md' } }),
    );
    expect(att).toMatchObject({ name: 'README.md', kind: 'text' });
    const img = await json<AttachmentRef>(
      await h.call(`/api/projects/${p.id}/files/attach`, { method: 'POST', json: { path: 'logo.png' } }),
    );
    expect(img.kind).toBe('image');
    const denied = await h.call(`/api/projects/${p.id}/files/attach`, { method: 'POST', json: { path: '.env' } });
    expect(denied.status).toBe(400);
  });
});

describe('home files', () => {
  it('lists the home directory, hides secrets and refuses escapes', async () => {
    await mkdir(path.join(h.homeDir, '.ssh'));
    await mkdir(path.join(h.homeDir, '.aws'));
    await writeFile(path.join(h.homeDir, '.ssh', 'id_ecdsa'), 'PRIVATE KEY\n');
    await writeFile(path.join(h.homeDir, '.aws', 'credentials'), 'aws_secret_access_key=1\n');
    await writeFile(path.join(h.homeDir, '.netrc'), 'machine x password y\n');
    const tree = await json<HomeFileTree>(await h.call('/api/home/files'));
    expect(tree.root).toBe(await realpath(h.homeDir));
    expect(tree.truncated).toBe(false);
    expect(tree.entries).toEqual([{ path: 'note.txt', type: 'file' }]);
    const file = await json<ProjectFileContent>(await h.call('/api/home/files/content?path=note.txt'));
    expect(file.content).toBe('hello from home\n');
    expect((await h.call('/api/home/files/content?path=.env')).status).toBe(400);
    expect((await h.call(`/api/home/files/content?path=${encodeURIComponent('../project/README.md')}`)).status).toBe(
      400,
    );
    const att = await json<AttachmentRef>(
      await h.call('/api/home/files/attach', { method: 'POST', json: { path: 'note.txt' } }),
    );
    expect(att).toMatchObject({ name: 'note.txt', kind: 'text' });
    for (const p of ['.ssh/id_ecdsa', '.aws/credentials']) {
      expect((await h.call(`/api/home/files/content?path=${encodeURIComponent(p)}`)).status, p).toBe(400);
    }
    for (const p of ['.netrc', '.aws/credentials']) {
      expect((await h.call('/api/home/files/attach', { method: 'POST', json: { path: p } })).status, p).toBe(400);
    }
  });
});

describe('change set lifecycle', () => {
  it('gets, applies (with revision) and discards', async () => {
    const p = await newProject();
    const chat = await newChat(p.id);
    expect(await json<ChatChanges>(await h.call(`/api/chats/${chat.id}/changes`))).toEqual({
      pending: null,
      applied: [],
    });
    expect((await h.call('/api/chats/nope/changes')).status).toBe(404);

    h.changes.seed(chat.id, pending(2));
    const stale = await h.call(`/api/chats/${chat.id}/changes/apply`, {
      method: 'POST',
      json: { revision: 1, decisions: {} },
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('changes_stale');

    const ok = await h.call(`/api/chats/${chat.id}/changes/apply`, {
      method: 'POST',
      json: { revision: 2, decisions: { 'src/a.ts': { '1:abcdef12': 'accepted' } } },
    });
    expect(ok.status).toBe(200);
    expect(h.changes.applyCalls.at(-1)).toMatchObject({ chatId: chat.id, revision: 2 });
    const body = await json<{ changes: ChatChanges }>(ok);
    expect(body.changes.pending).toBeNull();
    expect(body.changes.applied).toHaveLength(1);

    h.changes.seed(chat.id, pending(3));
    const cleared = await json<ChatChanges>(await h.call(`/api/chats/${chat.id}/changes`, { method: 'DELETE' }));
    expect(cleared.pending).toBeNull();
  });

  it('validates the apply body', async () => {
    const chat = await newChat((await newProject()).id);
    const res = await h.call(`/api/chats/${chat.id}/changes/apply`, { method: 'POST', json: { revision: 'x' } });
    expect(res.status).toBe(400);
  });

  it('refuses apply and discard while the chat is running', async () => {
    const p = await newProject();
    const chat = await newChat(p.id);
    h.changes.seed(chat.id, pending());
    h.core.agent = {
      runTurn: async () => {},
      isRunning: () => true,
      abort: () => {},
    } satisfies AgentService;
    const apply = await h.call(`/api/chats/${chat.id}/changes/apply`, {
      method: 'POST',
      json: { revision: 1, decisions: {} },
    });
    expect(apply.status).toBe(409);
    expect((await h.call(`/api/chats/${chat.id}/changes`, { method: 'DELETE' })).status).toBe(409);
    expect((await h.changes.get(chat.id)).pending).not.toBeNull();
  });

  it('refuses moving a chat that has pending edits, allows other patches', async () => {
    const p = await newProject();
    const chat = await newChat(p.id);
    h.changes.seed(chat.id, pending());
    const move = await h.call(`/api/chats/${chat.id}`, { method: 'PATCH', json: { projectId: null } });
    expect(move.status).toBe(409);
    expect(((await move.json()) as { error: { message: string } }).error.message).toBe(
      'Apply or discard the proposed edits first.',
    );
    expect((await h.call(`/api/chats/${chat.id}`, { method: 'PATCH', json: { title: 'x' } })).status).toBe(200);
    await h.changes.discard(chat.id);
    expect((await h.call(`/api/chats/${chat.id}`, { method: 'PATCH', json: { projectId: null } })).status).toBe(200);
  });

  it('deletes the change set with the chat and discards it when the project is removed', async () => {
    const p = await newProject();
    const a = await newChat(p.id);
    const b = await newChat(p.id);
    h.changes.seed(a.id, pending());
    h.changes.seed(b.id, pending());
    expect((await h.call(`/api/chats/${a.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await h.changes.get(a.id)).toEqual({ pending: null, applied: [] });
    expect((await h.call(`/api/projects/${p.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await h.changes.get(b.id)).pending).toBeNull();
  });

  it('relays changes_updated over SSE', async () => {
    const chat = await newChat((await newProject()).id);
    const event: AgentEvent = {
      type: 'changes_updated',
      messageId: 'm1',
      changes: {
        revision: 1,
        messageId: 'm1',
        files: [{ path: 'src/a.ts', kind: 'modify', add: 1, del: 1 }],
        totalAdd: 1,
        totalDel: 1,
      },
    };
    const clear: AgentEvent = { type: 'changes_updated', messageId: 'm1', changes: null };
    h.core.agent = {
      runTurn: async (input) => {
        await input.emit(event);
        await input.emit(clear);
        await input.emit({ type: 'done' });
      },
      isRunning: () => false,
      abort: () => {},
    };
    const res = await h.call(`/api/chats/${chat.id}/messages`, {
      method: 'POST',
      json: { text: 'hi', attachmentIds: [], model: MODEL },
    });
    expect(await collectEvents(res)).toEqual([event, clear, { type: 'done' }]);
  });
});
