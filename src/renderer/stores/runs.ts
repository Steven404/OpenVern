// Streaming runs (S7.1). One entry per chat id, fed by the `AgentEvent`s of `sendMessage` / `retry`.
// Runs live in this store (not in components), so they keep going when the user navigates away and the
// conversation shows their progress on return. The entry is an *overlay* on top of the persisted chat:
// `messages` holds the in-flight user message, streaming assistant text and tool results, and is dropped once
// the chat has been refetched after `done`.

import type { ApiErrorInfo } from '@shared/errors';
import { errorInfo } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import type { TerminalBridge, TerminalReadAnswer, TerminalReadRequest } from '@shared/terminal';
import type {
  AssistantMessage,
  AttachmentRef,
  Chat,
  ChatSummary,
  ChatUsage,
  EditMode,
  Id,
  Message,
  ReasoningEffort,
  UserMessage,
} from '@shared/types';
import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { type ApiClient, ApiError, isChatProjectChanged, isEditModeChanged } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { confirmEditMode, fetchChat } from './edit-modes';

export const PENDING_PREFIX = 'pending-';
export const isPendingId = (id: string) => id.startsWith(PENDING_PREFIX);

/** What the user typed, kept until the server confirmed it persisted the message (so Retry can resend it). */
export interface UnsentMessage {
  text: string;
  attachments: AttachmentRef[];
  model: string;
  /** F3: omitted = keep the chat's stored effort. */
  effort?: ReasoningEffort | null;
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
  /**
   * F1: the chat's usage when the run started, from the cached summary (`null` if it was not cached). The context
   * counter shows it while the run is active, so its figures change only when the run ends (plan §2).
   */
  usageBefore: ChatUsage | null;
  /**
   * A retry: the id of the user message it reruns. While set and the run is active, the persisted messages after it
   * are hidden (see `hideRetriedTail`), as the server drops them once it accepts the retry. Cleared when the server
   * never said it started (nothing was truncated) and whenever the run becomes idle, whatever the outcome; a refused
   * retry drops the run.
   */
  retryOf: Id | null;
}

export type RunEvent = AgentEvent | { type: 'aborted' };

export function createRun(
  token: number,
  user?: UserMessage,
  unsent?: UnsentMessage,
  usageBefore: ChatUsage | null = null,
  retryOf: Id | null = null,
): RunState {
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
    usageBefore,
    retryOf,
  };
}

/**
 * The persisted messages as a retry shows them: up to and including the user message it reruns. The cut is made when
 * rendering, never in the cache, so a retry the server refuses, or never starts, shows the earlier turn again, with
 * its Auto card and Undo, without waiting for a refetch. Showing too much is safe; hiding a write is not.
 *
 * INVARIANT: only an active run hides anything. A retry can fail before it truncates (the earlier turn and its writes
 * are intact) and the read after it can fail too, so an idle run never cuts a later read of the chat.
 */
export function hideRetriedTail(persisted: Message[], run?: RunState): Message[] {
  const retryOf = run?.retryOf;
  if (!retryOf || run.status === 'idle') return persisted;
  const at = persisted.findIndex((m) => m.id === retryOf && m.role === 'user');
  return at < 0 ? persisted : persisted.slice(0, at + 1);
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
    case 'auto_batch_updated':
      // The cards read the `chatChanges` query; `consume` invalidates it when these events arrive.
      return run;
    case 'terminal_read_request':
      // No state: `consume` relays it to the bridge and posts the answer back (see `relayTerminalRead`).
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
  /**
   * The PTY bridge from the preload, when this client can answer terminal reads (terminal plan §4.2). Its presence is
   * what makes each turn say `terminal: true` and what lets `terminal_read_request` be relayed.
   */
  terminal?: TerminalBridge;
}

/**
 * T3.6: the `read_terminal` relay. The backend asks through the run stream; the renderer reads its emulator buffer and posts
 * the answer under the same request id. Without a bridge the answer is `unavailable`, and a failed post is ignored:
 * the backend times out and tells the model the terminal didn't answer.
 */
export async function relayTerminalRead(
  deps: RunDeps,
  chatId: Id,
  request: { requestId: Id; request: TerminalReadRequest },
): Promise<void> {
  let answer: TerminalReadAnswer = { ok: false, reason: 'unavailable' };
  if (deps.terminal) {
    try {
      const { terminalRegistry } = await import('@renderer/features/terminal/registry');
      answer = await terminalRegistry.read(chatId, deps.terminal, request.request);
    } catch {
      answer = { ok: false, reason: 'unavailable' };
    }
  }
  try {
    await deps.api.answerTerminalRead(chatId, request.requestId, answer);
  } catch {
    // 404 when the backend already timed out or the run was aborted; nothing left to answer.
  }
}

export interface SendInput {
  text: string;
  attachments: AttachmentRef[];
  model: string;
  /** F3: omitted = keep the chat's stored effort (`null` = Default). */
  effort?: ReasoningEffort | null;
  /**
   * The edit mode the UI rendered when the user acted (the chip, or Review where none was shown). The server runs the
   * turn in exactly this mode or refuses it. Required, and never read from a cache here: a cache can hold a mode the
   * screen never showed.
   */
  expectedEditMode: EditMode;
  /**
   * The project the UI showed the chat in (`null` = no project). The server refuses the turn if the chat is in
   * another one by then (moved from another window), so a turn never runs in a project the sender didn't see.
   */
  expectedProjectId: Id | null;
}

/** `retry` input: the model and effort to rerun with, and the mode and project the UI rendered (as in `SendInput`). */
export interface RetryInput {
  model: string;
  effort?: ReasoningEffort | null;
  expectedEditMode: EditMode;
  expectedProjectId: Id | null;
}

/**
 * A send or retry the server refused because the chat's edit mode, or its project, was no longer the one the UI
 * showed. Nothing was
 * stored or started. The reply composer shows `message` in its error line and puts `unsent` (what was typed, when the
 * message never reached the server) back in the draft. Nothing is resent: the user checks Review / Auto first.
 */
export interface ModeRefusal {
  message: string;
  unsent: UnsentMessage | null;
}

export interface RunsState {
  runs: Record<Id, RunState>;
  /** Per chat, until the reply composer takes it (`takeModeRefusal`). */
  modeRefusals: Record<Id, ModeRefusal>;
  /** Removes and returns the chat's refusal, so it is shown once. */
  takeModeRefusal(chatId: Id): ModeRefusal | undefined;
  /** Model last chosen in each chat's composer (survives navigation; `retry` uses it). */
  chatModels: Record<Id, string>;
  setChatModel(chatId: Id, model: string): void;
  /** F3: effort last chosen in each chat's composer (survives navigation; `retry` uses it). */
  chatEfforts: Record<Id, ReasoningEffort | null>;
  setChatEffort(chatId: Id, effort: ReasoningEffort | null): void;
  /**
   * Starts a run with a new user message. Resolves when the run has ended and the chat was refetched; never
   * rejects (failures become `run.error`). Ignored while a run is active for the chat.
   */
  send(deps: RunDeps, chatId: Id, input: SendInput): Promise<void>;
  /** Re-runs the last user message (after an error or a stop); resends the typed text if it never persisted. */
  retry(deps: RunDeps, chatId: Id, input: RetryInput): Promise<void>;
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
  writeChatSummary(queryClient, summary, false);
}

/**
 * Run reports never change the cached edit mode. A run's `chat_updated` summaries were taken by the server at some
 * point during the turn and can land after the answer to a mode PATCH made meanwhile. No UI reads the cached mode
 * (the chip renders from `stores/edit-modes.ts`, which run reports never reach), so this only keeps the caches from
 * mirroring an older mode.
 */
export function patchRunSummary(queryClient: QueryClient, summary: ChatSummary) {
  writeChatSummary(queryClient, summary, true);
}

function writeChatSummary(queryClient: QueryClient, summary: ChatSummary, keepEditMode: boolean) {
  const merge = <T extends ChatSummary>(old: T): T => ({
    ...old,
    ...summary,
    ...(keepEditMode ? { editMode: old.editMode } : {}),
  });
  queryClient.setQueryData<ChatSummary[]>(queryKeys.chats, (old) => {
    if (!old) return old;
    const next = old.some((c) => c.id === summary.id)
      ? old.map((c) => (c.id === summary.id ? merge(c) : c))
      : [summary, ...old];
    return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
  queryClient.setQueryData<Chat>(queryKeys.chat(summary.id), (old) => (old ? merge(old) : old));
}

/**
 * The chat's usage as the UI currently shows it: the newer of the chats-list entry and the `chat(id)` data (the same
 * pick as `ChatScreen`). `null` when neither is cached.
 */
export function cachedUsage(queryClient: QueryClient, chatId: Id): ChatUsage | null {
  const listed = queryClient.getQueryData<ChatSummary[]>(queryKeys.chats)?.find((c) => c.id === chatId);
  const loaded = queryClient.getQueryData<Chat>(queryKeys.chat(chatId));
  if (!listed || !loaded) return (listed ?? loaded)?.usage ?? null;
  return (loaded.updatedAt > listed.updatedAt ? loaded : listed).usage;
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
        // Stamped like every chat read: it reaches the shown mode only if it started after the last mode answer.
        const chat = await fetchChat(deps.api, chatId);
        // A run's read: it keeps the cached edit mode (see `patchRunSummary`).
        deps.queryClient.setQueryData<Chat>(queryKeys.chat(chatId), (old) =>
          old ? { ...chat, editMode: old.editMode } : chat,
        );
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
    void deps.queryClient.invalidateQueries({ queryKey: queryKeys.chatChanges(chatId) });

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
            // An idle run hides nothing: either the chat was read after the run (the persisted list is the server's
            // own), or the read failed and the retry may never have truncated (an error before it did, with the
            // earlier turn's writes and Undo intact). Showing the old tail until a later read is safe; hiding it is not.
            retryOf: null,
          },
        },
      };
    });
  };

  /**
   * The server refused the turn because the chat's edit mode or project changed (a 409 before anything was stored).
   * The run is
   * dropped as if it never started (with it any tail a retry hid), the run it replaced comes back, what was typed goes
   * to the composer with the reason, and the chat's mode is checked again so Review / Auto shows the server's mode
   * (sending waits for that check). Nothing is resent.
   */
  const refuse = (deps: RunDeps, chatId: Id, token: number, previous: RunState | undefined, message: string) => {
    set((s) => {
      const run = s.runs[chatId];
      if (!run || run.token !== token) return s;
      const { [chatId]: _refused, ...rest } = s.runs;
      return {
        runs: previous ? { ...rest, [chatId]: previous } : rest,
        modeRefusals: { ...s.modeRefusals, [chatId]: { message, unsent: run.unsent } },
      };
    });
    void confirmEditMode(deps, chatId);
  };

  const consume = async (
    deps: RunDeps,
    chatId: Id,
    token: number,
    controller: AbortController,
    open: () => AsyncIterable<AgentEvent>,
    previous: RunState | undefined,
  ) => {
    // Whether the server said anything: until it does, nothing was stored or truncated.
    let heard = false;
    try {
      for await (const ev of open()) {
        heard = true;
        apply(chatId, token, ev);
        if (ev.type === 'terminal_read_request') void relayTerminalRead(deps, chatId, ev);
        if (ev.type === 'chat_updated') patchRunSummary(deps.queryClient, ev.chat);
        if (ev.type === 'changes_updated' || ev.type === 'auto_batch_updated') {
          void deps.queryClient.invalidateQueries({ queryKey: queryKeys.chatChanges(chatId) });
        }
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
      else if (isEditModeChanged(err) || isChatProjectChanged(err)) {
        if (controllers.get(chatId) === controller) controllers.delete(chatId);
        refuse(deps, chatId, token, previous, err.info.message);
        return;
      } else apply(chatId, token, { type: 'error', error: toErrorInfo(err) });
    }
    if (controller.signal.aborted && !get().runs[chatId]?.stopped) apply(chatId, token, { type: 'aborted' });
    // A failure or a Stop before the server said it started: nothing was truncated, so a retry hides nothing.
    if (!heard) patchRun(chatId, token, (r) => (r.retryOf === null ? r : { ...r, retryOf: null }));
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
    modeRefusals: {},
    takeModeRefusal(chatId) {
      const refusal = get().modeRefusals[chatId];
      if (refusal) {
        set((s) => {
          const { [chatId]: _taken, ...rest } = s.modeRefusals;
          return { modeRefusals: rest };
        });
      }
      return refusal;
    },
    chatModels: {},
    setChatModel: (chatId, model) => set((s) => ({ chatModels: { ...s.chatModels, [chatId]: model } })),
    chatEfforts: {},
    setChatEffort: (chatId, effort) => set((s) => ({ chatEfforts: { ...s.chatEfforts, [chatId]: effort } })),

    async send(deps, chatId, input) {
      if (isActive(chatId)) return;
      const pending: UserMessage = {
        id: `${PENDING_PREFIX}${crypto.randomUUID()}`,
        role: 'user',
        createdAt: new Date().toISOString(),
        text: input.text,
        attachments: input.attachments,
      };
      const usageBefore = cachedUsage(deps.queryClient, chatId);
      const { expectedEditMode, expectedProjectId } = input;
      // Kept for a resend; never the expected mode or project, which must come from the screen at the time of that
      // resend.
      const unsent: UnsentMessage = {
        text: input.text,
        attachments: input.attachments,
        model: input.model,
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
      };
      const previous = get().runs[chatId];
      const { token, controller } = start(chatId, (t) => createRun(t, pending, unsent, usageBefore));
      get().setChatModel(chatId, input.model);
      if (input.effort !== undefined) get().setChatEffort(chatId, input.effort);
      await consume(
        deps,
        chatId,
        token,
        controller,
        () =>
          deps.api.sendMessage(
            chatId,
            {
              text: input.text,
              attachmentIds: input.attachments.map((a) => a.id),
              model: input.model,
              ...(input.effort !== undefined ? { effort: input.effort } : {}),
              ...(deps.terminal ? { terminal: true } : {}),
              expectedEditMode,
              expectedProjectId,
            },
            controller.signal,
          ),
        previous,
      );
    },

    async retry(deps, chatId, input) {
      const { model, effort, expectedEditMode, expectedProjectId } = input;
      if (isActive(chatId)) return;
      const unsent = get().runs[chatId]?.unsent;
      if (unsent) {
        set((s) => {
          const { [chatId]: _old, ...rest } = s.runs;
          return { runs: rest };
        });
        return get().send(deps, chatId, {
          text: unsent.text,
          attachments: unsent.attachments,
          model,
          ...(effort !== undefined ? { effort } : {}),
          expectedEditMode,
          expectedProjectId,
        });
      }
      const usageBefore = cachedUsage(deps.queryClient, chatId);
      const previous = get().runs[chatId];
      // The server drops the messages after the last user message once it accepts the retry. The cache is left as it
      // is: the run hides that tail (`retryOf`), so a refusal shows it again at once, Auto cards and Undo included.
      const retryOf =
        deps.queryClient.getQueryData<Chat>(queryKeys.chat(chatId))?.messages.findLast((m) => m.role === 'user')?.id ??
        null;
      const { token, controller } = start(chatId, (t) => createRun(t, undefined, undefined, usageBefore, retryOf));
      get().setChatModel(chatId, model);
      if (effort !== undefined) get().setChatEffort(chatId, effort);
      await consume(
        deps,
        chatId,
        token,
        controller,
        () =>
          deps.api.retry(
            chatId,
            {
              model,
              ...(effort !== undefined ? { effort } : {}),
              ...(deps.terminal ? { terminal: true } : {}),
              expectedEditMode,
              expectedProjectId,
            },
            controller.signal,
          ),
        previous,
      );
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
