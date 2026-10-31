// The agent loop (S4.1–S4.8, S4.10). See plan §4.4 for the event grammar:
//   user_message → (assistant_start → text_delta* → assistant_end → (tool_call → tool_result)*)+ → chat_updated* → done
//
// Decisions (documented in the S4 report):
// - `error` is emitted as soon as the failure happens (right after `assistant_end` for provider errors); the trailing
//   `chat_updated` events (model/updatedAt, then title) come after it, and `done` is always last.
// - Every model call is announced with `assistant_start` before the provider is touched, so errors thrown at stream
//   start (e.g. `no_api_key`) take the same path as mid-stream errors: an empty-text `status: 'error'` assistant message
//   is persisted (the UI shows an error card on reload), then `assistant_end`, `error`, `done`.
// - Stop/error while streaming: tool calls the model had already completed are NOT persisted on that message (they never
//   ran). Stop while tools run: the in-flight tool and every not-yet-started call of that message get a persisted
//   `ok:false` "Interrupted" ToolMessage (with `tool_call` + `tool_result` events), so the stored chat is self-consistent.
//   `history.ts` still synthesises "Interrupted" results for legacy/dangling calls.

import { LIMITS, MAX_AGENT_STEPS, NEW_CHAT_TITLE } from '@shared/constants';
import { type ApiErrorInfo, errorInfo } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import type {
  AssistantMessage,
  Chat,
  ChatSummary,
  Id,
  Project,
  ToolCall,
  ToolMessage,
  Usage,
  UserMessage,
} from '@shared/types';
import { CoreError, toErrorInfo } from '../errors';
import type { Provider, ProviderMessage } from '../providers/types';
import type { GetProjectTools, RenderTree, Tool } from '../tools/types';
import type {
  AgentService,
  AttachmentsService,
  ChatsService,
  ModelCatalog,
  ProjectsService,
  RunTurnInput,
} from '../types';
import { buildHistory, INTERRUPTED_OUTPUT } from './history';
import { buildSystemPrompt } from './system-prompt';
import { generateTitle } from './title';

export interface AgentServiceDeps {
  chats: ChatsService;
  attachments: AttachmentsService;
  projects: ProjectsService;
  models: ModelCatalog;
  provider: Provider;
  getProjectTools: GetProjectTools;
  renderTree: RenderTree;
  /** Clock, injectable for tests. Also used to measure tool durations. */
  now?: () => Date;
  /** Title request timeout; default 10 s. */
  titleTimeoutMs?: number;
}

type Emit = (event: AgentEvent) => Promise<void>;

/** What happened during a run, so the epilogue knows what to announce. */
interface RunState {
  /** The chat was changed (message appended, truncated, model switched). */
  modified: boolean;
  /** The last assistant message finished normally with no pending tool calls. */
  completed: boolean;
}

export function toChatSummary(chat: ChatSummary | Chat): ChatSummary {
  return {
    id: chat.id,
    projectId: chat.projectId,
    title: chat.title,
    model: chat.model,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

function interrupted(): { ok: false; output: string; summary: string } {
  return { ok: false, output: INTERRUPTED_OUTPUT, summary: 'Interrupted' };
}

export function createAgentService(deps: AgentServiceDeps): AgentService {
  const { chats, attachments, projects, models, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const runs = new Map<Id, AbortController>();

  async function runTurn(input: RunTurnInput): Promise<void> {
    const { chatId } = input;
    const emit: Emit = async (event) => {
      try {
        await input.emit(event);
      } catch {
        // `emit` must not throw; if it does (e.g. a closed SSE stream) the run carries on and is stopped via `signal`.
      }
    };

    // Everything up to the first `await` is synchronous: the run is registered before the caller can observe anything.
    if (runs.has(chatId)) {
      await emit({
        type: 'error',
        error: errorInfo('conflict', 'A response is already being generated for this chat.'),
      });
      await emit({ type: 'done' });
      return;
    }
    const controller = new AbortController();
    runs.set(chatId, controller);
    const onAbort = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });

    const state: RunState = { modified: false, completed: false };
    try {
      try {
        await execute(input, controller.signal, emit, state);
      } catch (err) {
        await emit({ type: 'error', error: toErrorInfo(err) });
      }
      await epilogue(input, controller.signal, emit, state);
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      // Deregister before `done` so a client reacting to `done` can immediately start the next run.
      runs.delete(chatId);
      await emit({ type: 'done' });
    }
  }

  async function execute(input: RunTurnInput, signal: AbortSignal, emit: Emit, state: RunState): Promise<void> {
    const { chatId, model } = input;
    let chat = await chats.get(chatId);

    // S4.3: persist the new user message (binding its attachments) or truncate for a retry.
    if (input.newUserMessage) {
      const { text, attachmentIds } = input.newUserMessage;
      const refs = attachmentIds.length > 0 ? await attachments.bindToChat(attachmentIds, chatId) : [];
      const message: UserMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: now().toISOString(),
        text,
        attachments: refs,
      };
      await chats.appendMessage(chatId, message);
      state.modified = true;
      await emit({ type: 'user_message', message });
      chat = await chats.get(chatId);
    } else {
      chat = await chats.truncateAfterLastUser(chatId);
      if (chat.messages.at(-1)?.role !== 'user') {
        throw new CoreError('invalid_request', 'There is no message to retry in this chat.');
      }
      state.modified = true;
    }
    if (chat.model !== model) {
      await chats.update(chatId, { model });
      state.modified = true;
    }

    // Context for the requests.
    const modelInfo = await models.get(model);
    let project: Project | undefined;
    if (chat.projectId) {
      try {
        project = await projects.get(chat.projectId);
      } catch (err) {
        // A vanished project makes this a loose chat; anything else is a real failure.
        if (!(err instanceof CoreError && err.code === 'not_found')) throw err;
      }
    }
    const tools: Tool[] = project && modelInfo.supportsTools ? deps.getProjectTools() : []; // S4.8
    let tree: string | undefined;
    if (project && tools.length > 0) {
      try {
        tree = await deps.renderTree(project.rootPath, { depth: 2, maxEntries: LIMITS.systemPromptTreeEntries });
      } catch {
        tree = undefined; // the prompt is fine without it
      }
    }
    const system = buildSystemPrompt({
      now: now(),
      ...(project ? { project: { name: project.name, rootPath: project.rootPath } } : {}),
      hasTools: tools.length > 0,
      ...(tree !== undefined ? { tree } : {}),
    });
    const toolSpecs = tools.map((t) => t.spec);
    const history: ProviderMessage[] = await buildHistory(chat.messages, {
      model,
      supportsImages: modelInfo.supportsImages,
      readAttachment: (id) => attachments.readBytes(id),
    });

    // S4.4: the loop.
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const messageId = crypto.randomUUID();
      await emit({ type: 'assistant_start', messageId, model });

      let text = '';
      const toolCalls: ToolCall[] = [];
      let providerMeta: unknown;
      let usage: Usage | undefined;
      let failure: { status: 'stopped' } | { status: 'error'; error: ApiErrorInfo } | undefined;

      try {
        const stream = provider.stream(
          { model, system, messages: history, ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}) },
          signal,
        );
        for await (const ev of stream) {
          if (signal.aborted) break;
          if (ev.type === 'text_delta') {
            if (ev.delta.length === 0) continue;
            text += ev.delta;
            await emit({ type: 'text_delta', messageId, delta: ev.delta });
          } else if (ev.type === 'tool_call') toolCalls.push(ev.call);
          else if (ev.type === 'meta') providerMeta = ev.providerMeta;
          else if (ev.type === 'usage') usage = ev.usage;
        }
        if (signal.aborted) failure = { status: 'stopped' };
      } catch (err) {
        // S4.5/S4.6: an abort surfaces as whatever the provider throws, so look at the signal, not the error type.
        failure = signal.aborted ? { status: 'stopped' } : { status: 'error', error: toErrorInfo(err) };
      }

      const assistant: AssistantMessage = {
        id: messageId,
        role: 'assistant',
        createdAt: now().toISOString(),
        model,
        text,
        toolCalls: failure ? [] : toolCalls,
        status: failure ? failure.status : 'complete',
        ...(failure?.status === 'error' ? { error: failure.error } : {}),
        ...(usage ? { usage } : {}),
        ...(providerMeta !== undefined ? { providerMeta } : {}),
      };
      await chats.appendMessage(chatId, assistant);
      state.modified = true;
      await emit({ type: 'assistant_end', message: assistant });

      if (failure) {
        if (failure.status === 'error') await emit({ type: 'error', error: failure.error });
        return;
      }
      if (toolCalls.length === 0) {
        state.completed = true;
        return;
      }

      history.push({
        role: 'assistant',
        text,
        toolCalls,
        ...(providerMeta !== undefined ? { providerMeta } : {}),
      });
      for (const call of toolCalls) {
        const toolMessage = await runTool(call, messageId, tools, project, signal, emit);
        await chats.appendMessage(chatId, toolMessage);
        await emit({ type: 'tool_result', message: toolMessage });
        history.push({ role: 'tool', toolCallId: call.id, content: toolMessage.output });
      }
      if (signal.aborted) return; // S4.5: stopped during/after the tools; results above are all persisted
    }

    await emit({ type: 'error', error: errorInfo('max_steps_reached') });
  }

  /** Runs one tool call (emitting `tool_call` first). Never throws. */
  async function runTool(
    call: ToolCall,
    messageId: Id,
    tools: Tool[],
    project: Project | undefined,
    signal: AbortSignal,
    emit: Emit,
  ): Promise<ToolMessage> {
    await emit({ type: 'tool_call', messageId, toolCall: call });
    const started = now().getTime();

    const execute = async (): Promise<{ ok: boolean; output: string; summary: string }> => {
      if (signal.aborted) return interrupted();
      const tool = tools.find((t) => t.spec.name === call.name);
      if (!tool || !project) {
        const available = tools.map((t) => t.spec.name);
        return {
          ok: false,
          output:
            available.length > 0
              ? `Unknown tool "${call.name}". Available tools: ${available.join(', ')}.`
              : `Unknown tool "${call.name}". No tools are available in this chat.`,
          summary: `Unknown tool ${call.name}`,
        };
      }
      let args: unknown;
      try {
        args = call.argsJson.trim() === '' ? {} : JSON.parse(call.argsJson);
      } catch {
        return {
          ok: false,
          output: `Invalid arguments for "${call.name}": the arguments were not valid JSON. Send a single JSON object.`,
          summary: 'Invalid arguments',
        };
      }
      try {
        const result = await tool.run(args, { projectRoot: project.rootPath, signal });
        // A result that arrives after a stop is replaced, so what is stored never depends on a race.
        return signal.aborted ? interrupted() : result;
      } catch {
        // `Tool.run` must not throw; if it does, report it to the model without leaking details.
        return { ok: false, output: `The "${call.name}" tool failed unexpectedly.`, summary: 'Tool failed' };
      }
    };

    const result = await execute();
    return {
      id: crypto.randomUUID(),
      role: 'tool',
      createdAt: now().toISOString(),
      toolCallId: call.id,
      name: call.name,
      ok: result.ok,
      output: result.output,
      summary: result.summary,
      durationMs: Math.max(0, now().getTime() - started),
    };
  }

  /** Trailing `chat_updated` events (S4.10). Never throws. */
  async function epilogue(input: RunTurnInput, signal: AbortSignal, emit: Emit, state: RunState): Promise<void> {
    if (!state.modified) return;
    try {
      const chat = await chats.get(input.chatId);
      await emit({ type: 'chat_updated', chat: toChatSummary(chat) });

      if (!state.completed || chat.title !== NEW_CHAT_TITLE) return;
      const first = chat.messages.find((m): m is UserMessage => m.role === 'user');
      if (!first) return;
      const title = await generateTitle({
        provider,
        model: input.model,
        text: first.text,
        attachmentNames: first.attachments.map((a) => a.name),
        signal,
        ...(deps.titleTimeoutMs !== undefined ? { timeoutMs: deps.titleTimeoutMs } : {}),
      });
      if (!title || title === NEW_CHAT_TITLE) return;
      const summary = await chats.update(input.chatId, { title });
      await emit({ type: 'chat_updated', chat: toChatSummary(summary) });
    } catch {
      // Cosmetic; a storage failure here must not turn a finished turn into an error.
    }
  }

  return {
    runTurn,
    isRunning: (chatId) => runs.has(chatId),
    abort: (chatId) => runs.get(chatId)?.abort(),
  };
}
