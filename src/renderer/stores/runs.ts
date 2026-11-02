// Streaming runs (S7.1). One entry per chat id, fed by the `AgentEvent`s of `sendMessage` / `retry`.
// Runs live in this store (not in components), so they keep going when the user navigates away and the
// conversation shows their progress on return. The entry is an *overlay* on top of the persisted chat:
// `messages` holds the in-flight user message, streaming assistant text and tool results, and is dropped once
// the chat has been refetched after `done`.

import type { ApiErrorInfo } from '@shared/errors';
import { errorInfo } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import type { AssistantMessage, AttachmentRef, Chat, ChatSummary, Id, Message, UserMessage } from '@shared/types';
import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { type ApiClient, ApiError } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';

export const PENDING_PREFIX = 'pending-';
export const isPendingId = (id: string) => id.startsWith(PENDING_PREFIX);

/** What the user typed, kept until the server confirmed it persisted the message (so Retry can resend it). */
export interface UnsentMessage {
  text: string;
  attachments: AttachmentRef[];
  model: string;
}

export interface RunState {
  /** `running`: stream open · `settling`: stream ended, refetching the chat · `idle`: nothing in flight. */
  status: 'running' | 'settling' | 'idle';
  /** Virtual messages in order: user, assistant (streaming text), tool results. */
  messages: Message[];
  streamingId: Id | null;
  /** Tool call ids the server reported as running (`tool_call` without `tool_result` yet). */
  runningToolIds: string[];
  /** Run-level error (`error` event or a failed request). Kept until the next send / retry / dismiss. */
  error: ApiErrorInfo | null;
  /** The user pressed Stop. Kept after settle until the next send / retry, like `error`, so the last turn stays labelled. */
  stopped: boolean;
  sawDone: boolean;
  /** Set until `user_message` arrives. */
  unsent: UnsentMessage | null;
  /** Distinguishes consecutive runs of one chat (a late settle must not clear a newer run). */
  token: number;
}

export type RunEvent = AgentEvent | { type: 'aborted' };

export function createRun(token: number, user?: UserMessage, unsent?: UnsentMessage): RunState {
  return {
    status: 'running',
    messages: user ? [user] : [],
    streamingId: null,
    runningToolIds: [],
    error: null,
    stopped: false,
    sawDone: false,
    unsent: unsent ?? null,
    token,
  };
}

const replaceMessage = (messages: Message[], id: string, f: (m: Message) => Message): Message[] =>
  messages.map((m) => (m.id === id ? f(m) : m));

/** Pure reducer: applies one stream event to a run. Exported for tests. */
export function reduceRun(run: RunState, ev: RunEvent): RunState {
  switch (ev.type) {
    case 'user_message': {
      const pendingIdx = run.messages.findIndex((m) => m.role === 'user' && isPendingId(m.id));
      const messages =
        pendingIdx >= 0
          ? run.messages.map((m, i) => (i === pendingIdx ? ev.message : m))
          : run.messages.some((m) => m.id === ev.message.id)
            ? run.messages
            : [...run.messages, ev.message];
      return { ...run, messages, unsent: null };
    }
    case 'assistant_start': {
      if (run.messages.some((m) => m.id === ev.messageId)) return { ...run, streamingId: ev.messageId };
      const msg: AssistantMessage = {
        id: ev.messageId,
        role: 'assistant',
        createdAt: new Date().toISOString(),
        model: ev.model,
        text: '',
        toolCalls: [],
        status: 'complete',
      };
      return { ...run, messages: [...run.messages, msg], streamingId: ev.messageId };
    }
    case 'text_delta': {
      const exists = run.messages.some((m) => m.id === ev.messageId);
      const messages = exists
        ? replaceMessage(run.messages, ev.messageId, (m) =>
            m.role === 'assistant' ? { ...m, text: m.text + ev.delta } : m,
          )
        : [
            ...run.messages,
            {
              id: ev.messageId,
              role: 'assistant' as const,
              createdAt: new Date().toISOString(),
              model: '',
              text: ev.delta,
              toolCalls: [],
              status: 'complete' as const,
            },
          ];
      return { ...run, messages, streamingId: ev.messageId };
    }
    case 'changes_updated':
      // Stored and shown by the Proposed edits card (v0.2 goal G5); nothing to track in the run yet.
      return run;
    case 'tool_call':
      return run.runningToolIds.includes(ev.toolCall.id)
        ? run
        : { ...run, runningToolIds: [...run.runningToolIds, ev.toolCall.id] };
    case 'tool_result': {
      const messages = run.messages.some((m) => m.id === ev.message.id) ? run.messages : [...run.messages, ev.message];
      return { ...run, messages, runningToolIds: run.runningToolIds.filter((id) => id !== ev.message.toolCallId) };
    }
    case 'assistant_end': {
      const exists = run.messages.some((m) => m.id === ev.message.id);
      const messages = exists
        ? replaceMessage(run.messages, ev.message.id, () => ev.message)
        : [...run.messages, ev.message];
      return { ...run, messages, streamingId: run.streamingId === ev.message.id ? null : run.streamingId };
    }
    case 'chat_updated':
      return run;
    case 'error': {
      const streaming = run.streamingId;
      const messages = streaming
        ? replaceMessage(run.messages, streaming, (m) =>
            m.role === 'assistant' ? { ...m, status: 'error', error: ev.error } : m,
          )
        : run.messages;
      return { ...run, messages, streamingId: null, runningToolIds: [], error: ev.error };
    }
    case 'aborted': {
      const streaming = run.streamingId;
      const messages = streaming
        ? replaceMessage(run.messages, streaming, (m) => (m.role === 'assistant' ? { ...m, status: 'stopped' } : m))
        : run.messages;
      return { ...run, messages, streamingId: null, runningToolIds: [], stopped: true };
    }
    case 'done':
      return { ...run, streamingId: null, runningToolIds: [], sawDone: true };
  }
}

// ── store ────────────────────────────────────────────────────────────────────

export interface RunDeps {
  api: ApiClient;
  queryClient: QueryClient;
}

export interface SendInput {
  text: string;
  attachments: AttachmentRef[];
  model: string;
}

export interface RunsState {
  runs: Record<Id, RunState>;
  /** Model last chosen in each chat's composer (survives navigation; `retry` uses it). */
  chatModels: Record<Id, string>;
  setChatModel(chatId: Id, model: string): void;
  /**
   * Starts a run with a new user message. Resolves when the run has ended and the chat was refetched; never
   * rejects (failures become `run.error`). Ignored while a run is active for the chat.
   */
  send(deps: RunDeps, chatId: Id, input: SendInput): Promise<void>;
  /** Re-runs the last user message (after an error or a stop); resends the typed text if it never persisted. */
  retry(deps: RunDeps, chatId: Id, model: string): Promise<void>;
  /** Aborts the fetch; the server saves the partial reply as `stopped`. */
  stop(chatId: Id): void;
  /** Hides the run-level error card. */
  dismissError(chatId: Id): void;
}

const controllers = new Map<Id, AbortController>();
let tokenCounter = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function toErrorInfo(err: unknown): ApiErrorInfo {
  if (err instanceof ApiError) return err.info;
  return errorInfo('network_error', err instanceof Error && err.message ? err.message : undefined);
}

/** Patches cached summaries immediately (sidebar title, header, ordering). */
export function patchChatSummary(queryClient: QueryClient, summary: ChatSummary) {
  queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (old) => {
    if (!old) return old;
    const next = old.some((c) => c.id === summary.id)
      ? old.map((c) => (c.id === summary.id ? { ...c, ...summary } : c))
      : [summary, ...old];
    return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
  queryClient.setQueryData<Chat>(queryKeys.chat(summary.id), (old) => (old ? { ...old, ...summary } : old));
}

export const useRunsStore = create<RunsState>()((set, get) => {
  const patchRun = (chatId: Id, token: number, f: (r: RunState) => RunState) =>
    set((s) => {
      const run = s.runs[chatId];
      if (!run || run.token !== token) return s;
      return { runs: { ...s.runs, [chatId]: f(run) } };
    });

  const apply = (chatId: Id, token: number, ev: RunEvent) => patchRun(chatId, token, (r) => reduceRun(r, ev));

  const covered = (chat: Chat, run: RunState) =>
    run.messages.every((m) => isPendingId(m.id) || chat.messages.some((p) => p.id === m.id));

  const settle = async (deps: RunDeps, chatId: Id, token: number, aborted: boolean) => {
    patchRun(chatId, token, (r) => ({ ...r, status: 'settling' }));
    // After a client-side abort the server saves the partial reply asynchronously: poll briefly until it is there.
    const waitForServer = aborted && !get().runs[chatId]?.sawDone;
    const attempts = waitForServer ? 5 : 1;
    let refreshed = false;
    for (let i = 0; i < attempts; i++) {
      if (waitForServer) await sleep(i === 0 ? 250 : 400);
      try {
        const chat = await deps.api.getChat(chatId);
        deps.queryClient.setQueryData(queryKeys.chat(chatId), chat);
        refreshed = true;
        const run = get().runs[chatId];
        if (!run || run.token !== token || covered(chat, run)) break;
      } catch {
        // keep the overlay; the chat query refetches on its own
      }
    }
    if (!refreshed) void deps.queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    void deps.queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    void deps.queryClient.invalidateQueries({ queryKey: queryKeys.projects });

    set((s) => {
      const run = s.runs[chatId];
      if (!run || run.token !== token) return s;
      const keepMessages = !refreshed || run.unsent !== null;
      const keepStopped = run.stopped && !run.sawDone;
      if (!keepMessages && !run.error && !keepStopped) {
        const { [chatId]: _gone, ...rest } = s.runs;
        return { runs: rest };
      }
      return {
        runs: {
          ...s.runs,
          [chatId]: {
            ...run,
            status: 'idle',
            messages: keepMessages ? run.messages : [],
            streamingId: null,
            runningToolIds: [],
          },
        },
      };
    });
  };

  const consume = async (
    deps: RunDeps,
    chatId: Id,
    token: number,
    controller: AbortController,
    open: () => AsyncIterable<AgentEvent>,
  ) => {
    try {
      for await (const ev of open()) {
        apply(chatId, token, ev);
        if (ev.type === 'chat_updated') patchChatSummary(deps.queryClient, ev.chat);
      }
      const run = get().runs[chatId];
      if (!controller.signal.aborted && run?.token === token && !run.sawDone && !run.error) {
        apply(chatId, token, {
          type: 'error',
          error: errorInfo('network_error', 'The connection was interrupted before the reply finished.'),
        });
      }
    } catch (err) {
      if (controller.signal.aborted) apply(chatId, token, { type: 'aborted' });
      else apply(chatId, token, { type: 'error', error: toErrorInfo(err) });
    }
    if (controller.signal.aborted && !get().runs[chatId]?.stopped) apply(chatId, token, { type: 'aborted' });
    if (controllers.get(chatId) === controller) controllers.delete(chatId);
    await settle(deps, chatId, token, controller.signal.aborted);
  };

  const isActive = (chatId: Id) => {
    const status = get().runs[chatId]?.status;
    return status === 'running' || status === 'settling';
  };

  const start = (chatId: Id, run: (token: number) => RunState) => {
    const token = ++tokenCounter;
    const controller = new AbortController();
    controllers.set(chatId, controller);
    set((s) => ({ runs: { ...s.runs, [chatId]: run(token) } }));
    return { token, controller };
  };

  return {
    runs: {},
    chatModels: {},
    setChatModel: (chatId, model) => set((s) => ({ chatModels: { ...s.chatModels, [chatId]: model } })),

    async send(deps, chatId, input) {
      if (isActive(chatId)) return;
      const pending: UserMessage = {
        id: `${PENDING_PREFIX}${crypto.randomUUID()}`,
        role: 'user',
        createdAt: new Date().toISOString(),
        text: input.text,
        attachments: input.attachments,
      };
      const { token, controller } = start(chatId, (t) => createRun(t, pending, input));
      get().setChatModel(chatId, input.model);
      await consume(deps, chatId, token, controller, () =>
        deps.api.sendMessage(
          chatId,
          { text: input.text, attachmentIds: input.attachments.map((a) => a.id), model: input.model },
          controller.signal,
        ),
      );
    },

    async retry(deps, chatId, model) {
      if (isActive(chatId)) return;
      const unsent = get().runs[chatId]?.unsent;
      if (unsent) {
        set((s) => {
          const { [chatId]: _old, ...rest } = s.runs;
          return { runs: rest };
        });
        return get().send(deps, chatId, { ...unsent, model });
      }
      // The server drops the trailing assistant/tool messages; mirror that in the cache straight away.
      deps.queryClient.setQueryData<Chat>(queryKeys.chat(chatId), (old) => {
        if (!old) return old;
        const lastUser = old.messages.findLastIndex((m) => m.role === 'user');
        return { ...old, messages: old.messages.slice(0, lastUser + 1) };
      });
      const { token, controller } = start(chatId, (t) => createRun(t));
      get().setChatModel(chatId, model);
      await consume(deps, chatId, token, controller, () => deps.api.retry(chatId, { model }, controller.signal));
    },

    stop(chatId) {
      controllers.get(chatId)?.abort();
    },

    dismissError(chatId) {
      set((s) => {
        const run = s.runs[chatId];
        if (!run?.error) return s;
        if (run.status === 'idle' && run.messages.length === 0) {
          const { [chatId]: _gone, ...rest } = s.runs;
          return { runs: rest };
        }
        return { runs: { ...s.runs, [chatId]: { ...run, error: null } } };
      });
    },
  };
});

export const selectRun = (chatId: Id) => (s: RunsState) => s.runs[chatId];
/** `true` while a stream is open for the chat (the Stop button is shown). */
export const selectIsRunning = (chatId: Id) => (s: RunsState) => s.runs[chatId]?.status === 'running';
