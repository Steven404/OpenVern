import type { AgentEvent } from '@shared/events';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client';
import { MockApiClient } from './mock-api-client';

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('MockApiClient', () => {
  it('is seeded with the design sample data', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const projects = await api.listProjects();
    expect(projects.map((p) => [p.name, p.chatCount])).toEqual([
      ['Offline Notes App', 2],
      ['Portfolio site', 1],
      ['stefanos-ai-harness', 3],
    ]);
    const chats = await api.listChats();
    expect(chats).toHaveLength(6);
    const first = chats.find((c) => c.title === 'Agent loop and tool calls');
    const chat = await api.getChat(first?.id ?? '');
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('streams a tool turn in the documented order', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const [project] = await api.listProjects();
    const chat = await api.createChat({ projectId: project?.id ?? null, model: 'anthropic/claude-sonnet-5.5' });
    const events = await collect(
      api.sendMessage(chat.id, { text: 'Explain', attachmentIds: [], model: chat.model }, new AbortController().signal),
    );
    const types = events.map((e) => e.type).filter((t) => t !== 'text_delta');
    expect(types).toEqual([
      'user_message',
      'assistant_start',
      'assistant_end',
      'tool_call',
      'tool_result',
      'assistant_start',
      'assistant_end',
      'chat_updated',
      'done',
    ]);
    expect((await api.getChat(chat.id)).title).toBe('Explain');
  });

  it('does not offer tools in loose chats', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    const events = await collect(
      api.sendMessage(chat.id, { text: 'hi', attachmentIds: [], model: chat.model }, new AbortController().signal),
    );
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  });

  it('moves chats to "no project" when their project is removed', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const site = (await api.listProjects()).find((p) => p.name === 'Portfolio site');
    await api.deleteProject(site?.id ?? '');
    expect((await api.listChats()).filter((c) => c.projectId === null)).toHaveLength(1);
  });

  it('rejects invalid keys and duplicate projects with ApiError', async () => {
    const api = new MockApiClient({ delayMs: 0, keyConfigured: false });
    await expect(api.listModels()).rejects.toMatchObject({ info: { code: 'no_api_key' } });
    await expect(api.setOpenRouterKey('bad')).rejects.toBeInstanceOf(ApiError);
    const s = await api.setOpenRouterKey('sk-or-v1-0123456789abcdef');
    expect(s.openRouter).toEqual({ configured: true, keyHint: 'sk-or-v1-…cdef' });
    await api.createProject({ rootPath: '/tmp/x' });
    await expect(api.createProject({ rootPath: '/tmp/x/' })).rejects.toMatchObject({ status: 409 });
  });
});
