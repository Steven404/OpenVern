import { errorInfo } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import type { AssistantMessage, ChatSummary, ToolMessage, UserMessage } from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api-client';
import { MockApiClient } from '../lib/mock-api-client';
import { queryKeys } from '../lib/query-keys';
import { createRun, PENDING_PREFIX, type RunEvent, type RunState, reduceRun, toErrorInfo, useRunsStore } from './runs';

const user: UserMessage = { id: 'u1', role: 'user', createdAt: '', text: 'hi', attachments: [] };
const pending: UserMessage = { ...user, id: `${PENDING_PREFIX}1` };
const call = { id: 'call_1', name: 'read_file', argsJson: '{"path":"a.ts"}' };
const assistant1: AssistantMessage = {
  id: 'a1',
  role: 'assistant',
  createdAt: '',
  model: 'm',
  text: 'Let me look.',
  toolCalls: [call],
  status: 'complete',
};
const tool: ToolMessage = {
  id: 't1',
  role: 'tool',
  createdAt: '',
  toolCallId: 'call_1',
  name: 'read_file',
  ok: true,
  output: 'x',
  summary: 'a.ts',
  durationMs: 200,
};
const assistant2: AssistantMessage = { ...assistant1, id: 'a2', text: 'Done.', toolCalls: [] };
const summary: ChatSummary = {
  id: 'c1',
  projectId: null,
  title: 'T',
  model: 'm',
  createdAt: '',
  updatedAt: '',
  archived: false,
  usage: { contextTokens: 0, promptTokens: 0, completionTokens: 0, costUsd: null, requests: 0 },
  effort: null,
};

const run = (events: RunEvent[], start: RunState = createRun(1, pending)) => events.reduce(reduceRun, start);

describe('reduceRun', () => {
  it('replays a scripted turn: user, text, tool call, tool result, text, done', () => {
    const states: RunState[] = [];
    let state = createRun(1, pending, { text: 'hi', attachments: [], model: 'm' });
    const script: AgentEvent[] = [
      { type: 'user_message', message: user },
      { type: 'assistant_start', messageId: 'a1', model: 'm' },
      { type: 'text_delta', messageId: 'a1', delta: 'Let me ' },
      { type: 'text_delta', messageId: 'a1', delta: 'look.' },
      { type: 'assistant_end', message: assistant1 },
      { type: 'tool_call', messageId: 'a1', toolCall: call },
      { type: 'tool_result', message: tool },
      { type: 'assistant_start', messageId: 'a2', model: 'm' },
      { type: 'text_delta', messageId: 'a2', delta: 'Done.' },
      { type: 'assistant_end', message: assistant2 },
      { type: 'chat_updated', chat: summary },
      { type: 'done' },
    ];
    for (const ev of script) {
      state = reduceRun(state, ev);
      states.push(state);
    }

    // user_message replaces the pending bubble and clears `unsent`
    expect(states[0]?.messages.map((m) => m.id)).toEqual(['u1']);
    expect(states[0]?.unsent).toBeNull();
    // text accumulates on the streaming assistant message
    expect(states[1]?.streamingId).toBe('a1');
    expect(states[3]?.messages.at(-1)).toMatchObject({ id: 'a1', text: 'Let me look.' });
    // assistant_end settles it; the tool call is then running until its result
    expect(states[4]?.streamingId).toBeNull();
    expect(states[5]?.runningToolIds).toEqual(['call_1']);
    expect(states[6]?.runningToolIds).toEqual([]);
    expect(states[6]?.messages.map((m) => m.id)).toEqual(['u1', 'a1', 't1']);
    // second reply
    expect(states[7]?.streamingId).toBe('a2');
    expect(state.messages.map((m) => m.id)).toEqual(['u1', 'a1', 't1', 'a2']);
    expect(state.sawDone).toBe(true);
    expect(state.error).toBeNull();
  });

  it('marks the streaming message as errored and keeps the run-level error', () => {
    const state = run([
      { type: 'assistant_start', messageId: 'a1', model: 'm' },
      { type: 'text_delta', messageId: 'a1', delta: 'par' },
      { type: 'error', error: errorInfo('rate_limited') },
    ]);
    expect(state.error?.code).toBe('rate_limited');
    expect(state.streamingId).toBeNull();
    expect(state.messages.at(-1)).toMatchObject({ id: 'a1', text: 'par', status: 'error' });
  });

  it('aborted marks the streaming message stopped', () => {
    const state = run([
      { type: 'assistant_start', messageId: 'a1', model: 'm' },
      { type: 'text_delta', messageId: 'a1', delta: 'par' },
      { type: 'aborted' },
    ]);
    expect(state.stopped).toBe(true);
    expect(state.messages.at(-1)).toMatchObject({ id: 'a1', status: 'stopped' });
  });

  it('is idempotent for repeated ids and tolerates a missing assistant_start', () => {
    const state = run([
      { type: 'text_delta', messageId: 'a9', delta: 'x' },
      { type: 'assistant_end', message: { ...assistant2, id: 'a9' } },
      { type: 'tool_result', message: tool },
      { type: 'tool_result', message: tool },
    ]);
    expect(state.messages.filter((m) => m.id === 'a9')).toHaveLength(1);
    expect(state.messages.filter((m) => m.id === 't1')).toHaveLength(1);
  });
});

describe('useRunsStore', () => {
  beforeEach(() => useRunsStore.setState({ runs: {}, chatModels: {} }));

  async function setup() {
    const api = new MockApiClient({ delayMs: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const chat = (await api.listChats())[0];
    if (!chat) throw new Error('no seeded chat');
    const full = await api.getChat(chat.id);
    queryClient.setQueryData(queryKeys.chat(chat.id), full);
    queryClient.setQueryData(queryKeys.chats, await api.listChats());
    return { api, queryClient, chat: full, deps: { api, queryClient } };
  }

  it('runs a turn to completion, refetches the chat and clears the overlay', async () => {
    const { api, queryClient, chat, deps } = await setup();
    const before = chat.messages.length;
    await useRunsStore.getState().send(deps, chat.id, { text: 'again please', attachments: [], model: chat.model });

    expect(useRunsStore.getState().runs[chat.id]).toBeUndefined();
    const cached = queryClient.getQueryData<typeof chat>(queryKeys.chat(chat.id));
    expect(cached?.messages.length).toBe(before + 4); // user, assistant (tool call), tool result, assistant
    expect(cached?.messages.at(-1)?.role).toBe('assistant');
    expect((await api.getChat(chat.id)).messages.length).toBe(cached?.messages.length);
  });

  it('patches the cached summaries on chat_updated', async () => {
    const { queryClient, deps } = await setup();
    const api = deps.api;
    const created = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    queryClient.setQueryData(queryKeys.chat(created.id), created);
    queryClient.setQueryData(queryKeys.chats, await api.listChats());
    await useRunsStore
      .getState()
      .send(deps, created.id, { text: 'Name this chat', attachments: [], model: created.model });
    const list = queryClient.getQueryData<ChatSummary[]>(queryKeys.chats);
    expect(list?.find((c) => c.id === created.id)?.title).toBe('Name this chat');
    expect(queryClient.getQueryData<{ title: string }>(queryKeys.chat(created.id))?.title).toBe('Name this chat');
  });

  it('turns a failed request into a run error and keeps the unsent message for Retry', async () => {
    const api = new MockApiClient({ delayMs: 0, keyConfigured: false });
    const queryClient = new QueryClient();
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    queryClient.setQueryData(queryKeys.chat(chat.id), chat);
    const deps = { api, queryClient };
    await useRunsStore.getState().send(deps, chat.id, { text: 'hello', attachments: [], model: chat.model });

    const state = useRunsStore.getState().runs[chat.id];
    expect(state?.status).toBe('idle');
    expect(state?.error?.code).toBe('no_api_key');
    expect(state?.unsent?.text).toBe('hello');
    expect(state?.messages[0]).toMatchObject({ role: 'user', text: 'hello' });

    // Retry resends the typed text instead of calling /retry
    await api.setOpenRouterKey('sk-or-v1-abcdefghijklmnop');
    await useRunsStore.getState().retry(deps, chat.id, chat.model);
    expect(useRunsStore.getState().runs[chat.id]).toBeUndefined();
    const saved = await api.getChat(chat.id);
    expect(saved.messages[0]).toMatchObject({ role: 'user', text: 'hello' });
  });

  it('stop aborts the stream and the partial reply is saved as stopped', async () => {
    const api = new MockApiClient({ delayMs: 5 });
    const queryClient = new QueryClient();
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    queryClient.setQueryData(queryKeys.chat(chat.id), chat);
    const deps = { api, queryClient };
    const done = useRunsStore.getState().send(deps, chat.id, { text: 'go', attachments: [], model: chat.model });
    await new Promise((r) => setTimeout(r, 40));
    expect(useRunsStore.getState().runs[chat.id]?.status).toBe('running');
    useRunsStore.getState().stop(chat.id);
    await done;
    const saved = await api.getChat(chat.id);
    expect(saved.messages.at(-1)).toMatchObject({ role: 'assistant', status: 'stopped' });
    expect(useRunsStore.getState().runs[chat.id]).toMatchObject({
      status: 'idle',
      stopped: true,
      messages: [],
      error: null,
    });
  });

  it('stop during a tool run keeps a stopped entry after settle', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const queryClient = new QueryClient();
    const [project] = await api.listProjects();
    const chat = await api.createChat({ projectId: project?.id ?? null, model: 'anthropic/claude-sonnet-5.5' });
    queryClient.setQueryData(queryKeys.chat(chat.id), chat);
    const deps = { api, queryClient };
    const unsubscribe = useRunsStore.subscribe((s) => {
      if (s.runs[chat.id]?.runningToolIds.length) s.stop(chat.id);
    });
    await useRunsStore.getState().send(deps, chat.id, { text: 'go', attachments: [], model: chat.model });
    unsubscribe();
    expect(useRunsStore.getState().runs[chat.id]).toMatchObject({
      status: 'idle',
      stopped: true,
      messages: [],
      error: null,
    });
    const cached = queryClient.getQueryData<{ messages: { role: string; ok?: boolean }[] }>(queryKeys.chat(chat.id));
    expect(cached?.messages.at(-1)).toMatchObject({ role: 'tool', ok: false });
  });

  it('retry drops trailing messages from the cache and reruns', async () => {
    const { api, queryClient, chat, deps } = await setup();
    await useRunsStore.getState().retry(deps, chat.id, chat.model);
    const saved = await api.getChat(chat.id);
    expect(saved.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(saved.messages.at(-1)?.role).toBe('assistant');
    expect(queryClient.getQueryData<typeof chat>(queryKeys.chat(chat.id))?.messages).toHaveLength(
      saved.messages.length,
    );
  });

  /** Records the run's `usageBefore` the first time it is seen running. */
  function captureUsageBefore(chatId: string) {
    const seen: { value?: RunState['usageBefore'] } = {};
    const unsubscribe = useRunsStore.subscribe((st) => {
      const r = st.runs[chatId];
      if (r?.status === 'running' && !('value' in seen)) seen.value = r.usageBefore;
    });
    return { seen, unsubscribe };
  }

  it('send captures the cached usage at run start in usageBefore', async () => {
    const { queryClient, chat, deps } = await setup();
    const cached = queryClient.getQueryData<ChatSummary[]>(queryKeys.chats)?.find((c) => c.id === chat.id)?.usage;
    expect(cached?.requests).toBeGreaterThan(0);
    const { seen, unsubscribe } = captureUsageBefore(chat.id);
    await useRunsStore.getState().send(deps, chat.id, { text: 'again please', attachments: [], model: chat.model });
    unsubscribe();
    expect(seen.value).toEqual(cached);
  });

  it('send on a just-created chat captures usageBefore with 0 requests', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const queryClient = new QueryClient();
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    queryClient.setQueryData(queryKeys.chat(chat.id), chat);
    const { seen, unsubscribe } = captureUsageBefore(chat.id);
    await useRunsStore
      .getState()
      .send({ api, queryClient }, chat.id, { text: 'hi', attachments: [], model: chat.model });
    unsubscribe();
    expect(seen.value).toMatchObject({ requests: 0, contextTokens: 0 });
  });

  it('usageBefore is null when the chat is not cached', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    const { seen, unsubscribe } = captureUsageBefore(chat.id);
    await useRunsStore
      .getState()
      .send({ api, queryClient: new QueryClient() }, chat.id, { text: 'hi', attachments: [], model: chat.model });
    unsubscribe();
    expect(seen.value).toBeNull();
  });

  it('usageBefore follows the newer of the chats list and the chat query', async () => {
    const { queryClient, chat, deps } = await setup();
    const newer = { ...chat, updatedAt: '9999-01-01T00:00:00.000Z', usage: { ...chat.usage, requests: 99 } };
    queryClient.setQueryData(queryKeys.chat(chat.id), newer);
    const { seen, unsubscribe } = captureUsageBefore(chat.id);
    await useRunsStore.getState().send(deps, chat.id, { text: 'go', attachments: [], model: chat.model });
    unsubscribe();
    expect(seen.value?.requests).toBe(99);
  });

  it('retry captures the cached usage at run start in usageBefore', async () => {
    const { queryClient, chat, deps } = await setup();
    const cached = queryClient.getQueryData<ChatSummary[]>(queryKeys.chats)?.find((c) => c.id === chat.id)?.usage;
    expect(cached?.requests).toBeGreaterThan(0);
    const { seen, unsubscribe } = captureUsageBefore(chat.id);
    await useRunsStore.getState().retry(deps, chat.id, chat.model);
    unsubscribe();
    expect(seen.value).toEqual(cached);
  });

  it('retry of an unsent first message captures usageBefore with 0 requests', async () => {
    const api = new MockApiClient({ delayMs: 0, keyConfigured: false });
    const queryClient = new QueryClient();
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    queryClient.setQueryData(queryKeys.chat(chat.id), chat);
    const deps = { api, queryClient };
    await useRunsStore.getState().send(deps, chat.id, { text: 'hello', attachments: [], model: chat.model });
    expect(useRunsStore.getState().runs[chat.id]?.unsent?.text).toBe('hello');

    await api.setOpenRouterKey('sk-or-v1-abcdefghijklmnop');
    const { seen, unsubscribe } = captureUsageBefore(chat.id);
    await useRunsStore.getState().retry(deps, chat.id, chat.model);
    unsubscribe();
    expect(seen.value).toMatchObject({ requests: 0 });
  });

  it('maps ApiErrors to their info and anything else to network_error', () => {
    expect(toErrorInfo(new ApiError(errorInfo('internal'))).code).toBe('internal');
    expect(toErrorInfo(new TypeError('boom'))).toMatchObject({ code: 'network_error', message: 'boom' });
  });
});
