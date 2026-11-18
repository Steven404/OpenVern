vi.mock('@renderer/features/terminal/registry', () => ({ terminalRegistry: { read: vi.fn() } }));

import { terminalRegistry } from '@renderer/features/terminal/registry';
import { EDIT_MODE_CHANGED } from '@shared/api';
import { errorInfo } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import type { TerminalReadAnswer } from '@shared/terminal';
import type {
  AssistantMessage,
  Chat,
  ChatSummary,
  ModelInfo,
  ReasoningEffort,
  ToolMessage,
  UserMessage,
} from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTerminalBridge } from '../features/terminal/test-fakes';
import { ApiError } from '../lib/api-client';
import { MockApiClient } from '../lib/mock-api-client';
import { queryKeys } from '../lib/query-keys';
import {
  createRun,
  PENDING_PREFIX,
  patchChatSummary,
  type RunEvent,
  type RunState,
  reduceRun,
  toErrorInfo,
  useRunsStore,
} from './runs';

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
  editMode: 'review',
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

  it('tolerates a terminal_read_request without changing the run', () => {
    const start = run([
      { type: 'assistant_start', messageId: 'a1', model: 'm' },
      { type: 'text_delta', messageId: 'a1', delta: 'par' },
    ]);
    const next = reduceRun(start, {
      type: 'terminal_read_request',
      requestId: 'r1',
      request: { startLine: 1, count: 10 },
    });
    expect(next).toEqual(start);
    expect(next.streamingId).toBe('a1');
  });
});

describe('useRunsStore', () => {
  beforeEach(() => useRunsStore.setState({ runs: {}, chatModels: {}, chatEfforts: {} }));

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

  it.each(['auto_batch_updated', 'changes_updated'] as const)(
    '%s invalidates only this chat changes query when consumed',
    async (type) => {
      const { api, queryClient, chat, deps } = await setup();
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      let invalidatedDuringStream = false;
      vi.spyOn(api, 'sendMessage').mockImplementation(async function* () {
        yield type === 'auto_batch_updated'
          ? { type, batchId: 'batch' }
          : { type, messageId: 'assistant', changes: null };
        invalidatedDuringStream = queryClient.getQueryState(queryKeys.chatChanges(chat.id))?.isInvalidated === true;
        yield { type: 'done' };
      });
      queryClient.setQueryData(queryKeys.chatChanges(chat.id), { pending: null, applied: [], diskSeq: 0 });
      await useRunsStore.getState().send(deps, chat.id, { text: 'go', attachments: [], model: chat.model });
      expect(invalidatedDuringStream).toBe(true);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.chatChanges(chat.id) });
      expect(
        invalidate.mock.calls.filter(
          ([arg]) => JSON.stringify(arg?.queryKey) === JSON.stringify(queryKeys.chatChanges('other')),
        ),
      ).toHaveLength(0);
      expect(queryClient.getQueryState(queryKeys.chatChanges(chat.id))?.isInvalidated).toBe(true);
    },
  );

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

  // ── F3: per-chat effort ──
  it("setChatEffort remembers each chat's effort, including null (Default), and overwrites it", () => {
    const { setChatEffort } = useRunsStore.getState();
    expect(useRunsStore.getState().chatEfforts).toEqual({});
    setChatEffort('c1', 'high');
    setChatEffort('c2', null);
    expect(useRunsStore.getState().chatEfforts).toEqual({ c1: 'high', c2: null });
    setChatEffort('c1', 'low');
    expect(useRunsStore.getState().chatEfforts).toEqual({ c1: 'low', c2: null });
  });

  it('send records the effort it was sent with and passes it to the API', async () => {
    const { api, chat, deps } = await setup();
    const sendSpy = vi.spyOn(api, 'sendMessage');
    await useRunsStore
      .getState()
      .send(deps, chat.id, { text: 'hi', attachments: [], model: chat.model, effort: 'high' });
    expect(useRunsStore.getState().chatEfforts[chat.id]).toBe('high');
    expect(sendSpy.mock.calls[0]?.[1]).toMatchObject({ effort: 'high' });
  });

  it('send without an effort keeps the recorded one and omits effort from the API call', async () => {
    const { api, chat, deps } = await setup();
    const sendSpy = vi.spyOn(api, 'sendMessage');
    useRunsStore.getState().setChatEffort(chat.id, 'low');
    await useRunsStore.getState().send(deps, chat.id, { text: 'hi', attachments: [], model: chat.model });
    expect(useRunsStore.getState().chatEfforts[chat.id]).toBe('low');
    expect(sendSpy.mock.calls[0]?.[1]).not.toHaveProperty('effort');
  });

  it('retry records its effort and passes it on; omitting it keeps the recorded one', async () => {
    const { api, chat, deps } = await setup();
    const retrySpy = vi.spyOn(api, 'retry');
    await useRunsStore.getState().retry(deps, chat.id, chat.model, 'max');
    expect(useRunsStore.getState().chatEfforts[chat.id]).toBe('max');
    expect(retrySpy.mock.calls[0]?.[1]).toEqual({ model: chat.model, effort: 'max', expectedEditMode: 'review' });

    await useRunsStore.getState().retry(deps, chat.id, chat.model);
    expect(useRunsStore.getState().chatEfforts[chat.id]).toBe('max');
    expect(retrySpy.mock.calls[1]?.[1]).toEqual({ model: chat.model, expectedEditMode: 'review' });
  });

  it('retry of an unsent message carries the effort it is given', async () => {
    const api = new MockApiClient({ delayMs: 0, keyConfigured: false });
    const queryClient = new QueryClient();
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    queryClient.setQueryData(queryKeys.chat(chat.id), chat);
    const deps = { api, queryClient };
    await useRunsStore
      .getState()
      .send(deps, chat.id, { text: 'hello', attachments: [], model: chat.model, effort: 'low' });
    expect(useRunsStore.getState().runs[chat.id]?.unsent).toMatchObject({ text: 'hello', effort: 'low' });

    await api.setOpenRouterKey('sk-or-v1-abcdefghijklmnop');
    const sendSpy = vi.spyOn(api, 'sendMessage');
    await useRunsStore.getState().retry(deps, chat.id, chat.model, 'high');
    expect(useRunsStore.getState().runs[chat.id]).toBeUndefined();
    expect(sendSpy.mock.calls[0]?.[1]).toMatchObject({ effort: 'high' });
  });

  describe('raw effort (F3 follow-up)', () => {
    /** A cached model list entry with the given levels (the models query, not a network call). */
    const withLevels = (id: string, efforts: ReasoningEffort[]): ModelInfo => ({
      id,
      name: id,
      contextLength: 1000,
      supportsTools: true,
      supportsImages: false,
      supportsReasoning: true,
      reasoningEfforts: efforts,
      promptPricePerMTok: null,
      completionPricePerMTok: null,
    });

    it('send passes the raw effort even when the cached model does not list it', async () => {
      const { api, chat, deps, queryClient } = await setup();
      queryClient.setQueryData(queryKeys.models, [withLevels(chat.model, ['low', 'high'])]);
      const sendSpy = vi.spyOn(api, 'sendMessage');
      await useRunsStore
        .getState()
        .send(deps, chat.id, { text: 'one', attachments: [], model: chat.model, effort: 'max' });
      expect(sendSpy.mock.calls[0]?.[1]).toHaveProperty('effort', 'max');
    });

    it('chatEfforts keeps the raw choice', async () => {
      const { api, chat, deps, queryClient } = await setup();
      queryClient.setQueryData(queryKeys.models, [withLevels(chat.model, ['low', 'high'])]);
      vi.spyOn(api, 'sendMessage');
      await useRunsStore
        .getState()
        .send(deps, chat.id, { text: 'hi', attachments: [], model: chat.model, effort: 'max' });
      expect(useRunsStore.getState().chatEfforts[chat.id]).toBe('max');
    });

    it('retry passes the raw effort even when the cached model does not list it, and keeps the raw choice', async () => {
      const { api, chat, deps, queryClient } = await setup();
      queryClient.setQueryData(queryKeys.models, [withLevels(chat.model, ['low', 'high'])]);
      const retrySpy = vi.spyOn(api, 'retry');
      await useRunsStore.getState().retry(deps, chat.id, chat.model, 'max');
      expect(retrySpy.mock.calls[0]?.[1]).toEqual({ model: chat.model, effort: 'max', expectedEditMode: 'review' });
      expect(useRunsStore.getState().chatEfforts[chat.id]).toBe('max');

      await useRunsStore.getState().retry(deps, chat.id, chat.model, 'low');
      expect(retrySpy.mock.calls[1]?.[1]).toEqual({ model: chat.model, effort: 'low', expectedEditMode: 'review' });
      expect(useRunsStore.getState().chatEfforts[chat.id]).toBe('low');
    });

    it('a retry of an unsent message passes the raw effort', async () => {
      const api = new MockApiClient({ delayMs: 0, keyConfigured: false });
      const queryClient = new QueryClient();
      const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
      queryClient.setQueryData(queryKeys.chat(chat.id), chat);
      const deps = { api, queryClient };
      await useRunsStore
        .getState()
        .send(deps, chat.id, { text: 'hello', attachments: [], model: chat.model, effort: 'low' });
      expect(useRunsStore.getState().runs[chat.id]?.unsent).toMatchObject({ text: 'hello', effort: 'low' });

      await api.setOpenRouterKey('sk-or-v1-abcdefghijklmnop');
      queryClient.setQueryData(queryKeys.models, [withLevels(chat.model, ['low', 'max'])]);
      const sendSpy = vi.spyOn(api, 'sendMessage');
      await useRunsStore.getState().retry(deps, chat.id, chat.model, 'high');
      expect(sendSpy.mock.calls[0]?.[1]).toHaveProperty('effort', 'high');
    });
  });

  it('efforts are kept per chat: choosing one does not change another', () => {
    useRunsStore.getState().setChatEffort('a', 'high');
    expect(useRunsStore.getState().chatEfforts.b).toBeUndefined();
    expect(useRunsStore.getState().chatEfforts.a).toBe('high');
  });

  it('maps ApiErrors to their info and anything else to network_error', () => {
    expect(toErrorInfo(new ApiError(errorInfo('internal'))).code).toBe('internal');
    expect(toErrorInfo(new TypeError('boom'))).toMatchObject({ code: 'network_error', message: 'boom' });
  });
});

describe('terminal relay (T3.6)', () => {
  beforeEach(() => useRunsStore.setState({ runs: {}, chatModels: {}, chatEfforts: {} }));
  afterEach(() => vi.restoreAllMocks());

  const readRequest: AgentEvent = {
    type: 'terminal_read_request',
    requestId: 'req-1',
    request: { startLine: 3, count: 10 },
  };
  const answer: TerminalReadAnswer = {
    ok: true,
    result: {
      info: { chatId: 'c', shell: 'zsh', cwd: '/home/you', cols: 80, rows: 24, status: { state: 'running' } },
      totalLines: 40,
      startLine: 3,
      endLine: 12,
      text: 'the lines',
      truncated: false,
    },
  };
  const input = { text: 'what is on screen?', attachments: [], model: 'anthropic/claude-sonnet-5.5' };

  /** A run stream that yields `events`, then `done`, as the server ends a turn. */
  async function* streamOf(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
    yield* events;
    yield { type: 'done' };
  }

  async function setupChat() {
    const api = new MockApiClient({ delayMs: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    queryClient.setQueryData(queryKeys.chat(chat.id), chat);
    return { api, queryClient, chat };
  }

  it('a terminal_read_request reads that chat’s terminal and answers under the same request id', async () => {
    const { api, queryClient, chat } = await setupChat();
    const bridge = new FakeTerminalBridge();
    vi.mocked(terminalRegistry.read).mockResolvedValue(answer);
    vi.spyOn(api, 'sendMessage').mockImplementation(() => streamOf([readRequest]));
    const answerSpy = vi.spyOn(api, 'answerTerminalRead').mockResolvedValue(undefined);

    await useRunsStore.getState().send({ api, queryClient, terminal: bridge }, chat.id, { ...input, attachments: [] });

    await vi.waitFor(() => expect(answerSpy).toHaveBeenCalledWith(chat.id, 'req-1', answer));
    expect(terminalRegistry.read).toHaveBeenCalledWith(chat.id, bridge, { startLine: 3, count: 10 });
  });

  it('posts the answer only once the read has resolved', async () => {
    const { api, queryClient, chat } = await setupChat();
    const bridge = new FakeTerminalBridge();
    let finishRead: (value: TerminalReadAnswer) => void = () => {};
    vi.mocked(terminalRegistry.read).mockImplementation(
      () =>
        new Promise<TerminalReadAnswer>((resolve) => {
          finishRead = resolve;
        }),
    );
    vi.spyOn(api, 'sendMessage').mockImplementation(() => streamOf([readRequest]));
    const answerSpy = vi.spyOn(api, 'answerTerminalRead').mockResolvedValue(undefined);

    await useRunsStore.getState().send({ api, queryClient, terminal: bridge }, chat.id, { ...input, attachments: [] });
    await vi.waitFor(() => expect(terminalRegistry.read).toHaveBeenCalled());
    expect(answerSpy).not.toHaveBeenCalled();

    finishRead(answer);
    await vi.waitFor(() => expect(answerSpy).toHaveBeenCalledWith(chat.id, 'req-1', answer));
  });

  it('without a bridge it answers unavailable', async () => {
    const { api, queryClient, chat } = await setupChat();
    vi.spyOn(api, 'sendMessage').mockImplementation(() => streamOf([readRequest]));
    const answerSpy = vi.spyOn(api, 'answerTerminalRead').mockResolvedValue(undefined);

    await useRunsStore.getState().send({ api, queryClient }, chat.id, { ...input, attachments: [] });

    await vi.waitFor(() =>
      expect(answerSpy).toHaveBeenCalledWith(chat.id, 'req-1', { ok: false, reason: 'unavailable' }),
    );
  });

  it('a read that throws is answered unavailable', async () => {
    const { api, queryClient, chat } = await setupChat();
    const bridge = new FakeTerminalBridge();
    vi.mocked(terminalRegistry.read).mockRejectedValue(new Error('the shell is gone'));
    vi.spyOn(api, 'sendMessage').mockImplementation(() => streamOf([readRequest]));
    const answerSpy = vi.spyOn(api, 'answerTerminalRead').mockResolvedValue(undefined);

    await useRunsStore.getState().send({ api, queryClient, terminal: bridge }, chat.id, { ...input, attachments: [] });

    await vi.waitFor(() =>
      expect(answerSpy).toHaveBeenCalledWith(chat.id, 'req-1', { ok: false, reason: 'unavailable' }),
    );
  });

  it('a failed answer does not break the run: the rest of the reply still streams and settles cleanly', async () => {
    vi.mocked(terminalRegistry.read).mockResolvedValue(answer);
    const { api, queryClient, chat } = await setupChat();
    const bridge = new FakeTerminalBridge();
    const persisted: UserMessage = { id: 'u1', role: 'user', createdAt: '', text: input.text, attachments: [] };
    vi.spyOn(api, 'sendMessage').mockImplementation(() =>
      streamOf([
        { type: 'user_message', message: persisted },
        readRequest,
        { type: 'assistant_start', messageId: 'a1', model: 'm' },
        { type: 'text_delta', messageId: 'a1', delta: 'still here' },
      ]),
    );
    const answerSpy = vi.spyOn(api, 'answerTerminalRead').mockRejectedValue(new ApiError(errorInfo('not_found'), 404));
    const seen: string[] = [];
    const unsubscribe = useRunsStore.subscribe((s) => {
      const message = s.runs[chat.id]?.messages.find((m) => m.id === 'a1');
      if (message?.role === 'assistant') seen.push(message.text);
    });

    await useRunsStore.getState().send({ api, queryClient, terminal: bridge }, chat.id, { ...input, attachments: [] });
    unsubscribe();

    await vi.waitFor(() => expect(answerSpy).toHaveBeenCalled());
    expect(seen).toContain('still here');
    expect(useRunsStore.getState().runs[chat.id]).toBeUndefined();
  });

  it('send says terminal: true only when the client has a bridge', async () => {
    const { api, queryClient, chat } = await setupChat();
    const sendSpy = vi.spyOn(api, 'sendMessage').mockImplementation(() => streamOf([]));

    await useRunsStore.getState().send({ api, queryClient }, chat.id, { ...input, attachments: [] });
    expect(sendSpy.mock.calls[0]?.[1]).not.toHaveProperty('terminal');

    await useRunsStore
      .getState()
      .send({ api, queryClient, terminal: new FakeTerminalBridge() }, chat.id, { ...input, attachments: [] });
    expect(sendSpy.mock.calls[1]?.[1]).toMatchObject({ terminal: true });
  });

  it('retry says terminal: true only when the client has a bridge', async () => {
    const { api, queryClient, chat } = await setupChat();
    const retrySpy = vi.spyOn(api, 'retry').mockImplementation(() => streamOf([]));

    await useRunsStore.getState().retry({ api, queryClient }, chat.id, chat.model);
    expect(retrySpy.mock.calls[0]?.[1]).not.toHaveProperty('terminal');

    await useRunsStore.getState().retry({ api, queryClient, terminal: new FakeTerminalBridge() }, chat.id, chat.model);
    expect(retrySpy.mock.calls[1]?.[1]).toMatchObject({ terminal: true });
  });

  it('retry of an unsent message sends terminal: true too', async () => {
    const api = new MockApiClient({ delayMs: 0, keyConfigured: false });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const chat = await api.createChat({ projectId: null, model: 'anthropic/claude-sonnet-5.5' });
    queryClient.setQueryData(queryKeys.chat(chat.id), chat);
    await useRunsStore.getState().send({ api, queryClient }, chat.id, { ...input, text: 'hello', attachments: [] });
    expect(useRunsStore.getState().runs[chat.id]?.unsent?.text).toBe('hello');

    await api.setOpenRouterKey('sk-or-v1-abcdefghijklmnop');
    const sendSpy = vi.spyOn(api, 'sendMessage').mockImplementation(() => streamOf([]));
    await useRunsStore.getState().retry({ api, queryClient, terminal: new FakeTerminalBridge() }, chat.id, chat.model);
    expect(sendSpy.mock.calls[0]?.[1]).toMatchObject({ text: 'hello', terminal: true });
  });
});

describe('edit mode: what the UI showed, and what a run may not change', () => {
  beforeEach(() => useRunsStore.setState({ runs: {}, chatModels: {}, chatEfforts: {}, modeRefusals: {} }));
  afterEach(() => vi.restoreAllMocks());

  /** The seed's newest chat (in a project), cached as the conversation and the sidebar cache it, in `mode`. */
  async function setup(mode: 'review' | 'auto' = 'review') {
    const api = new MockApiClient({ delayMs: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const listed = (await api.listChats())[0];
    if (!listed) throw new Error('no seeded chat');
    await api.updateChat(listed.id, { editMode: mode });
    const chat = await api.getChat(listed.id);
    queryClient.setQueryData(queryKeys.chat(chat.id), chat);
    queryClient.setQueryData(queryKeys.chats, await api.listChats());
    return { api, queryClient, chat, deps: { api, queryClient } };
  }
  const cachedChat = (queryClient: QueryClient, id: string) => queryClient.getQueryData<Chat>(queryKeys.chat(id));
  const listedChat = (queryClient: QueryClient, id: string) =>
    queryClient.getQueryData<ChatSummary[]>(queryKeys.chats)?.find((c) => c.id === id);
  /** Holds a request open until `open()`. */
  function gate() {
    let open: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  it.each(['review', 'auto'] as const)(
    'send and retry pass the cached chat mode (%s) as expectedEditMode',
    async (mode) => {
      const { api, chat, deps } = await setup(mode);
      const send = vi.spyOn(api, 'sendMessage');
      const retry = vi.spyOn(api, 'retry');
      await useRunsStore.getState().send(deps, chat.id, { text: 'hi', attachments: [], model: chat.model });
      await useRunsStore.getState().retry(deps, chat.id, chat.model);
      expect(send.mock.calls[0]?.[1]).toMatchObject({ expectedEditMode: mode });
      expect(retry.mock.calls[0]?.[1]).toMatchObject({ expectedEditMode: mode });
    },
  );

  it('sends no expectedEditMode when the chat is not cached', async () => {
    const { api, chat, deps, queryClient } = await setup();
    queryClient.removeQueries({ queryKey: queryKeys.chat(chat.id) });
    const send = vi.spyOn(api, 'sendMessage');
    await useRunsStore.getState().send(deps, chat.id, { text: 'hi', attachments: [], model: chat.model });
    expect(send.mock.calls[0]?.[1]).not.toHaveProperty('expectedEditMode');
  });

  it('a refused send: no overlay, the typed message is handed back once, the chat is fetched again, nothing resent', async () => {
    const { api, chat, deps, queryClient } = await setup('review');
    await api.updateChat(chat.id, { editMode: 'auto' }); // the server moved on; the cache still shows Review
    const earlier = { ...createRun(7), status: 'idle' as const, error: errorInfo('provider_error') };
    useRunsStore.setState({ runs: { [chat.id]: earlier } });
    const send = vi.spyOn(api, 'sendMessage');
    const getChat = vi.spyOn(api, 'getChat');
    const attachment = { id: 'att', name: 'a.txt', mime: 'text/plain', size: 1, kind: 'text' as const };
    await useRunsStore
      .getState()
      .send(deps, chat.id, { text: 'make the edits', attachments: [attachment], model: chat.model, effort: 'low' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ expectedEditMode: 'review' });
    // The run it replaced is back, untouched; no pending bubble, no error card for the refusal.
    expect(useRunsStore.getState().runs[chat.id]).toEqual(earlier);
    await vi.waitFor(() => expect(cachedChat(queryClient, chat.id)?.editMode).toBe('auto'));
    expect(getChat).toHaveBeenCalled();
    expect((await api.getChat(chat.id)).messages).toEqual(chat.messages);
    const refusal = useRunsStore.getState().takeModeRefusal(chat.id);
    expect(refusal).toEqual({
      message: EDIT_MODE_CHANGED,
      unsent: { text: 'make the edits', attachments: [attachment], model: chat.model, effort: 'low' },
    });
    expect(useRunsStore.getState().takeModeRefusal(chat.id)).toBeUndefined();
  });

  it('a refused retry: the stopped run comes back, the hidden messages are fetched back, nothing is resent', async () => {
    const { api, chat, deps, queryClient } = await setup('review');
    await api.updateChat(chat.id, { editMode: 'auto' });
    const stopped = { ...createRun(3), status: 'idle' as const, stopped: true };
    useRunsStore.setState({ runs: { [chat.id]: stopped } });
    const retry = vi.spyOn(api, 'retry');
    await useRunsStore.getState().retry(deps, chat.id, chat.model);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(useRunsStore.getState().runs[chat.id]).toEqual(stopped);
    await vi.waitFor(() => expect(cachedChat(queryClient, chat.id)?.editMode).toBe('auto'));
    // The optimistic truncation is undone by the refetch; the server truncated nothing.
    expect(cachedChat(queryClient, chat.id)?.messages).toEqual(chat.messages);
    expect((await api.getChat(chat.id)).messages).toEqual(chat.messages);
    expect(useRunsStore.getState().takeModeRefusal(chat.id)).toEqual({ message: EDIT_MODE_CHANGED, unsent: null });
  });

  it('any other refusal stays a run error, as before', async () => {
    const { api, chat, deps } = await setup();
    vi.spyOn(api, 'sendMessage').mockImplementation(() => {
      throw new ApiError(errorInfo('conflict', 'A reply is already in progress.'), 409);
    });
    await useRunsStore.getState().send(deps, chat.id, { text: 'hi', attachments: [], model: chat.model });
    expect(useRunsStore.getState().runs[chat.id]?.error?.message).toBe('A reply is already in progress.');
    expect(useRunsStore.getState().modeRefusals).toEqual({});
  });

  it("a delayed chat_updated carrying the old mode doesn't overwrite a confirmed mode change", async () => {
    const { api, chat, deps, queryClient } = await setup('review');
    const late = gate();
    const after = gate();
    const old: ChatSummary = { ...(listedChat(queryClient, chat.id) as ChatSummary), title: 'Named by the run' };
    vi.spyOn(api, 'sendMessage').mockImplementation(async function* () {
      await late.promise;
      yield { type: 'chat_updated', chat: old }; // taken by the server before the mode change
      await after.promise;
      yield { type: 'done' };
    });
    const running = useRunsStore.getState().send(deps, chat.id, { text: 'hi', attachments: [], model: chat.model });
    // The PATCH answer is written (what the composer does), then the old summary arrives.
    patchChatSummary(queryClient, await api.updateChat(chat.id, { editMode: 'auto' }));
    late.open();
    await vi.waitFor(() => expect(cachedChat(queryClient, chat.id)?.title).toBe('Named by the run'));
    expect(cachedChat(queryClient, chat.id)?.editMode).toBe('auto');
    expect(listedChat(queryClient, chat.id)).toMatchObject({ title: 'Named by the run', editMode: 'auto' });
    after.open();
    await running;
    expect(cachedChat(queryClient, chat.id)?.editMode).toBe('auto');
  });

  it("a settle read that captured the old mode doesn't overwrite a confirmed mode change", async () => {
    const { api, chat, deps, queryClient } = await setup('review');
    const real = api.getChat.bind(api);
    const answer = gate();
    const getChat = vi.spyOn(api, 'getChat').mockImplementation(async (id) => {
      const snapshot = await real(id); // the server answers with Review…
      await answer.promise; // …and the answer lands late
      return snapshot;
    });
    const running = useRunsStore.getState().send(deps, chat.id, { text: 'hi', attachments: [], model: chat.model });
    await vi.waitFor(() => expect(getChat).toHaveBeenCalled());
    patchChatSummary(queryClient, await api.updateChat(chat.id, { editMode: 'auto' }));
    answer.open();
    await running;
    const cached = cachedChat(queryClient, chat.id);
    expect(cached?.editMode).toBe('auto');
    // Everything else the read brought is taken: the new turn's messages.
    expect(cached?.messages.length).toBeGreaterThan(chat.messages.length);
  });

  it('a mode change answered by a PATCH still writes the mode (only run reports keep it)', async () => {
    const { api, chat, queryClient } = await setup('review');
    patchChatSummary(queryClient, await api.updateChat(chat.id, { editMode: 'auto' }));
    expect(cachedChat(queryClient, chat.id)?.editMode).toBe('auto');
    expect(listedChat(queryClient, chat.id)?.editMode).toBe('auto');
  });
});
