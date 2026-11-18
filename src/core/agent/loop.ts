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
//   `history.ts` still synthesises "Interrupted" results for legacy/dangling calls. A tool call that wrote to disk
//   (Auto) keeps its real result even when Stop arrived meanwhile, and even when the chat couldn't be saved: then the
//   result is still emitted, held in memory and appended before the chat's next turn replays the history.

import { CHAT_PROJECT_CHANGED, RETRY_OTHER_PROJECT } from '@shared/api';
import {
  LIMITS,
  MAX_AGENT_STEPS,
  MAX_REPEATED_TOOL_STEPS,
  NEW_CHAT_TITLE,
  TREE_UNAVAILABLE_NOTICE,
} from '@shared/constants';
import { type ApiErrorInfo, errorInfo } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import type { TerminalReadRequest } from '@shared/terminal';
import type {
  AssistantMessage,
  BatchUndo,
  ChangeSummary,
  Chat,
  ChatSummary,
  EditMode,
  Id,
  Project,
  ToolCall,
  ToolMessage,
  Usage,
  UserMessage,
} from '@shared/types';
import { CoreError, toErrorInfo } from '../errors';
import type { Provider, ProviderMessage, ToolSpec } from '../providers/types';
import { redactionNote, redactSecrets } from '../security/redact';
import type {
  ChatToolContext,
  GetProjectTools,
  GetTerminalTools,
  RenderTree,
  Tool,
  ToolChanges,
  ToolResult,
} from '../tools/types';
import type {
  AgentService,
  AttachmentsService,
  ChangesService,
  ChatsService,
  ModelCatalog,
  ProjectsService,
  RunTurnInput,
  TerminalReadBroker,
} from '../types';
import { EDIT_TOOL_NAMES, retryUndoNote, retryUndoNotice, withModeLine } from './edit-mode';
import { buildHistory, flattenToolCall, INTERRUPTED_OUTPUT } from './history';
import { buildIdentity } from './identity';
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
  /**
   * Exact secret values (the stored API key) redacted from tool output and replayed history (plan K1). Read once per
   * turn; a failure counts as "none", and prefix-based redaction still applies.
   */
  getKnownSecrets?: () => Promise<readonly string[]>;
  /** Clock, injectable for tests. Also used to measure tool durations. */
  now?: () => Date;
  /** Title request timeout; default 10 s. */
  titleTimeoutMs?: number;
  /** Project tree timeout; default `LIMITS.systemPromptTreeTimeoutMs`. */
  treeTimeoutMs?: number;
  /** App version for the model identity prompt (v0.2 G6). */
  version?: string;
  /**
   * The change-set service (v0.2). When present, project chats with a tools-capable model get the edit tools and
   * their edits are staged here; when absent the agent is read-only.
   */
  changes?: ChangesService;
  /**
   * Terminal reads (terminal plan T2.3). With both present, a turn whose input says `terminal: true` gets these tools
   * when the model supports tools, in project chats and chats without a project alike, and their reads go through
   * the broker.
   */
  terminalReads?: TerminalReadBroker;
  getTerminalTools?: GetTerminalTools;
}

/**
 * A tool offered for this request, bound to what it needs: a project tool carries its project root, so it can only
 * be offered in a project chat; a chat tool runs with the chat context alone.
 */
interface OfferedTool {
  spec: ToolSpec;
  run(rawArgs: unknown, ctx: ChatToolContext, changes: ToolChanges | undefined): Promise<ToolResult>;
}

function projectTool(tool: Tool, projectRoot: string): OfferedTool {
  return {
    spec: tool.spec,
    run: (rawArgs, ctx, changes) => tool.run(rawArgs, { ...ctx, projectRoot, ...(changes ? { changes } : {}) }),
  };
}

function chatTool(tool: Tool<ChatToolContext>): OfferedTool {
  return { spec: tool.spec, run: (rawArgs, ctx) => tool.run(rawArgs, ctx) };
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
    archived: chat.archived,
    usage: chat.usage,
    effort: chat.effort,
    editMode: chat.editMode,
  };
}

/**
 * Wraps a `ToolChanges` to notice what a tool call did: staged something (the loop then emits `changes_updated`) or
 * wrote to disk (`auto_batch_updated`, and the result is kept even after Stop). Reads are held until the loop knows
 * the result reached the model: kept, and appended to the chat (`commitReads`). Committed reads still wait for the
 * end of the step (`endStep`) before the stale-read check can use them.
 */
function trackChanges(inner: ToolChanges): TrackedChanges {
  let staged: { summary: ChangeSummary | null } | undefined;
  let written: { batchId: Id } | undefined;
  /** The current tool call's reads, until its kept result is in the chat. */
  let reads: [string, Uint8Array][] = [];
  /** Reads of this step whose results are in the chat, in order, until the step is over. */
  let stepReads: [string, Uint8Array][] = [];
  return {
    mode: inner.mode,
    read: (p) => inner.read(p),
    staged: () => inner.staged(),
    noteRead: (p, bytes) => void reads.push([p, bytes]),
    async stage(p, content) {
      const result = await inner.stage(p, content);
      staged = { summary: result.summary };
      return result;
    },
    async write(p, content, opts) {
      // WRITES ARE NEVER HIDDEN (see the change service): `write` throws only before the project file changed, so a
      // write that reached the disk always gets here, also when its change history couldn't be saved yet.
      const result = await inner.write(p, content, opts);
      // `batchId` is null only when nothing changed on disk.
      if (result.batchId !== null) written = { batchId: result.batchId };
      // A write that changed the file has just recorded its own bytes as seen (or, for a delete, dropped the record),
      // under the same resolved path as a read's. An earlier read of this step saw the bytes before it, so it must not
      // replace that record at the end of the step: the next write would be refused as stale.
      if (result.file) {
        const changed = result.file.path;
        stepReads = stepReads.filter(([rel]) => rel !== changed);
      }
      return result;
    },
    reset: () => {
      staged = undefined;
      written = undefined;
      reads = [];
    },
    commitReads: () => {
      stepReads.push(...reads);
      reads = [];
    },
    endStep: () => {
      const done = stepReads;
      stepReads = [];
      for (const [p, bytes] of done) inner.noteRead(p, bytes);
    },
    lastStage: () => staged,
    lastWrite: () => written,
  };
}

interface TrackedChanges extends ToolChanges {
  /** Called before each tool call. */
  reset(): void;
  lastStage(): { summary: ChangeSummary | null } | undefined;
  /** The current tool call changed a project file (Auto). */
  lastWrite(): { batchId: Id } | undefined;
  /**
   * The current tool call's result is kept and in the chat, so the model will see what it read: its reads join the
   * step's, which `endStep` records.
   */
  commitReads(): void;
  /**
   * The step is over: records its committed reads as seen, in order. Called once per step, before the next model
   * request, also when the step ended early (Stop, a failed save), so the reads already in the chat are never lost.
   */
  endStep(): void;
}

/** `extra` appended to a user message's existing note, as its own block. */
const appendNote = (note: string | undefined, extra: string): string => (note ? `${note}\n\n${extra}` : extra);

function interrupted(): { ok: false; output: string; summary: string } {
  return { ok: false, output: INTERRUPTED_OUTPUT, summary: 'Interrupted' };
}

/** Object keys sorted at every level (arrays keep their order), so the same arguments spelled differently compare equal. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((key) => [key, sortKeys(obj[key])]),
    );
  }
  return value;
}

/** Canonical form of a tool call's raw arguments; text that is not JSON is compared as typed (trimmed). */
function canonicalArgs(argsJson: string): string {
  if (argsJson.trim() === '') return '{}'; // runTool runs blank args as {}, so they are the same call
  try {
    return JSON.stringify(sortKeys(JSON.parse(argsJson)));
  } catch {
    return argsJson.trim();
  }
}

/**
 * Identity of one step's tool calls and their results, for the stuck-loop guard. Calls are sorted, so a parallel step
 * compares equal however the model ordered it. Text, timing and call ids are left out on purpose.
 */
function stepSignature(entries: { name: string; args: string; ok: boolean; output: string }[]): string {
  return entries
    .map((e) => JSON.stringify([e.name, canonicalArgs(e.args), e.ok, e.output]))
    .sort()
    .join('\n');
}

export function createAgentService(deps: AgentServiceDeps): AgentService {
  const { chats, attachments, projects, models, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const runs = new Map<Id, AbortController>();
  /**
   * Results of tool calls that changed a project file but couldn't be appended to the chat, per chat, in call order.
   * In memory only (lost on a quit or crash, like an unsaved change history). Only touched by the chat's run.
   */
  const unrecorded = new Map<Id, ToolMessage[]>();

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

  /** Whether a project still exists; a failure other than `not_found` is a real one. */
  const projectExists = (id: Id): Promise<boolean> =>
    projects.get(id).then(
      () => true,
      (err) => (err instanceof CoreError && err.code === 'not_found' ? false : Promise.reject(err)),
    );

  async function execute(input: RunTurnInput, signal: AbortSignal, emit: Emit, state: RunState): Promise<void> {
    const { chatId, model } = input;
    let chat = await chats.get(chatId);
    // MODE READ ONCE PER TURN (invariant), and the project with it: the edit mode and the project are read once, at
    // turn start, and used for the whole run: the tool descriptions, the system prompt, the note, the snapshot, the
    // retry undo and restore, and the write path. The HTTP routes do that read themselves, under the turn's start
    // claim, check the mode against the one the client showed, and pass both in as `input.editMode` and
    // `input.projectId`; the turn must use those very values, because a PATCH can land between their read and this
    // one (a PATCH takes no run claim). A mode change would run the turn in a mode the user wasn't shown, and a move
    // would run the checked mode in a project it wasn't checked for. Only a caller that passes neither (tests, direct
    // use) gets this read. A PATCH during the run is stored but applies from the next turn; reading the mode again
    // mid-run could tell the model its edits are proposals while they are written to disk, or the other way round.
    const editMode: EditMode = input.editMode ?? chat.editMode;
    const projectId: Id | null = input.projectId !== undefined ? input.projectId : chat.projectId;

    let project: Project | undefined;
    if (projectId) {
      // PINNED PROJECT EXISTS (invariant): the turn's project was read under the start claim. If it is gone by now (a
      // removal committed in between), the turn fails here, before any attachment is bound, note taken, message
      // appended, snapshot taken, undo run or history truncated. It never runs as a loose turn the user didn't send.
      project = await projects.get(projectId).catch((err) => {
        if (err instanceof CoreError && err.code === 'not_found') throw new CoreError('conflict', CHAT_PROJECT_CHANGED);
        throw err;
      });
    }
    // A write an earlier run couldn't record goes into the chat first, before anything of this turn (a retry's
    // check, undo and truncation included) and before the history is replayed: the model is never told "Interrupted"
    // about a write that reached the disk. If it still can't be appended, this turn fails here, before anything of
    // its own is stored.
    if (unrecorded.has(chatId)) chat = await recordHeld(chatId);

    /** What a retry undid before starting over, for the notice on its first assistant message. */
    let retryUndo: BatchUndo | undefined;
    // S4.3: persist the new user message (binding its attachments) or truncate for a retry.
    if (input.newUserMessage) {
      const { text, attachmentIds } = input.newUserMessage;
      const refs = attachmentIds.length > 0 ? await attachments.bindToChat(attachmentIds, chatId) : [];
      const firstTurn = !chat.messages.some((m) => m.role === 'user');
      const changesNote = projectId ? await deps.changes?.takeNote(chatId, { mode: editMode, firstTurn }) : undefined;
      const message: UserMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: now().toISOString(),
        text,
        attachments: refs,
        ...(changesNote ? { changesNote } : {}),
      };
      await chats.appendMessage(chatId, message);
      // Remember the pending edits as they were when this turn started, so a retry can restore them (plan §3.2).
      if (projectId) await deps.changes?.snapshot(chatId, message.id);
      state.modified = true;
      await emit({ type: 'user_message', message });
      chat = await chats.get(chatId);
    } else {
      const lastUser = chat.messages.findLast((m): m is UserMessage => m.role === 'user');
      if (!lastUser) throw new CoreError('invalid_request', 'There is no message to retry in this chat.');
      const firstTurn = chat.messages.find((m) => m.role === 'user') === lastUser;
      // RETRY ORDER (invariant): check → undo → note → truncate → restore.
      // 0. Check (RETRY STAYS IN ITS PROJECT, invariant): a retry undoes the attempt's writes first, which it can only
      //    do in the project they were written to. While they are still undoable in another project that still
      //    exists, the retry is refused before anything is stored, undone, noted or truncated. The run claim keeps
      //    this answer valid until step 1: no other run, Undo, Apply or retention can change the turn's batches
      //    meanwhile, and a move only closes batches, which leaves them as undoable as before. A removed project's
      //    writes can't be undone from the app any more, so they never block.
      // 1. Undo: the files the previous attempt wrote (Auto) go back to how the turn found them, whatever mode this
      //    retry runs in. Nothing else has changed yet, so if the undo throws, the history still holds the previous
      //    attempt's tool results, which say what is on disk, and the retry ends with the error.
      // 2. Note: the mode line is made true for the mode this retry runs in, then the files the undo had to skip
      //    (they still hold the previous attempt's edits) are added. That is stored on the user message (so a replay
      //    of the history says it too) before any later step can fail and lose it.
      // 3. Truncate: only once the disk is back to the turn's start (as far as it could be) does the history drop the
      //    attempt.
      // 4. Restore: last, the pending set goes back to its state at the turn's start, so proposals never sit on top
      //    of files the attempt left behind.
      const info = deps.changes
        ? await deps.changes.retryInfo({ chatId, turnId: lastUser.id, projectId: project?.id ?? null })
        : null;
      for (const other of info?.writtenElsewhere ?? []) {
        if (await projectExists(other)) throw new CoreError('conflict', RETRY_OTHER_PROJECT);
      }
      const undone =
        project && deps.changes
          ? await deps.changes.prepareRetry({
              chatId,
              projectId: project.id,
              projectRoot: project.rootPath,
              turnId: lastUser.id,
              mode: editMode,
            })
          : null;
      if (undone) {
        await emit({ type: 'auto_batch_updated', batchId: undone.batchId });
        retryUndo = undone.undo;
      }
      // A loose retry has no edit tools and no mode in effect: its note stays as it is.
      let note = lastUser.changesNote;
      if (project && info) note = withModeLine(note, { mode: editMode, lastMode: info.lastMode, firstTurn });
      if (undone && undone.undo.skipped.length > 0) note = appendNote(note, retryUndoNote(undone.undo));
      if (note !== lastUser.changesNote) {
        await chats.setChangesNote(chatId, lastUser.id, note);
        state.modified = true;
      }
      chat = await chats.truncateAfterLastUser(chatId);
      state.modified = true;
      if (projectId) await deps.changes?.restore(chatId, lastUser.id);
    }
    // The user message that started this turn; auto batches are keyed by it.
    const turnId = chat.messages.findLast((m) => m.role === 'user')?.id ?? '';
    if (chat.model !== model) {
      await chats.update(chatId, { model });
      state.modified = true;
    }
    // F3: the body's effort wins; omitted = the chat's stored effort (a retry keeps it). Stored even when the model
    // doesn't support reasoning: it is only dropped from the request (plan §2).
    const effort = input.effort === undefined ? chat.effort : input.effort;
    if (chat.effort !== effort) {
      await chats.update(chatId, { effort });
      state.modified = true;
    }

    // Context for the requests.
    // F3 follow-up: only send a level the model actually publishes. Default (`null`), a model with no published
    // levels, or one that does not list this level all send no `reasoning` field; the chat still stores the choice.
    const modelInfo = await models.get(model);
    const reasoningEffort =
      modelInfo.supportsReasoning === true && effort !== null && modelInfo.reasoningEfforts?.includes(effort)
        ? effort
        : undefined;
    const canEdit = !!(project && modelInfo.supportsTools && deps.changes); // v0.2 G2.4
    const editNames: readonly string[] = EDIT_TOOL_NAMES;
    const projectTools: OfferedTool[] =
      project && modelInfo.supportsTools
        ? deps
            .getProjectTools({ editMode })
            .filter((t) => canEdit || !editNames.includes(t.spec.name)) // S4.8
            .map((t) => projectTool(t, project.rootPath))
        : [];
    // Terminal plan T2.3: offered in any chat, project or not, when the client can answer reads.
    const terminalReads = deps.terminalReads;
    const terminal =
      input.terminal && modelInfo.supportsTools && terminalReads && deps.getTerminalTools
        ? {
            tools: deps.getTerminalTools().map(chatTool),
            reader: {
              read: (request: TerminalReadRequest) => terminalReads.request(chatId, request, { emit, signal }),
            },
          }
        : undefined;
    const tools: OfferedTool[] = [...projectTools, ...(terminal?.tools ?? [])];
    let tree: string | undefined;
    let treeTimedOut = false;
    if (project) {
      // A hung filesystem call can't be cancelled, so the wait itself is raced against the timeout and Stop.
      const treeSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(deps.treeTimeoutMs ?? LIMITS.systemPromptTreeTimeoutMs),
      ]);
      const gaveUp = new Promise<'gave_up'>((resolve) => {
        if (treeSignal.aborted) resolve('gave_up');
        else treeSignal.addEventListener('abort', () => resolve('gave_up'), { once: true });
      });
      const built = deps
        .renderTree(project.rootPath, {
          depth: 2,
          maxEntries: LIMITS.systemPromptTreeEntries,
          signal: treeSignal,
        })
        .catch(() => undefined); // the prompt is fine without it
      const outcome = await Promise.race([built, gaveUp]);
      if (signal.aborted) {
        await stopBeforeModel(chatId, model, emit, state, retryUndo ? retryUndoNotice(retryUndo) : undefined);
        return;
      }
      if (treeSignal.aborted || outcome === 'gave_up') treeTimedOut = true;
      else tree = outcome;
    }
    // UI-only notice on the run's first assistant message: the tree timeout, then what a retry undid.
    const firstNotice =
      [treeTimedOut ? TREE_UNAVAILABLE_NOTICE : undefined, retryUndo ? retryUndoNotice(retryUndo) : undefined]
        .filter((n): n is string => n !== undefined)
        .join(' ') || undefined;
    const system = buildSystemPrompt({
      identity: buildIdentity(modelInfo, deps.version ?? '0.0.0'),
      now: now(),
      ...(project ? { project: { name: project.name, rootPath: project.rootPath } } : {}),
      hasTools: projectTools.length > 0,
      canEdit,
      editMode,
      terminal: (terminal?.tools.length ?? 0) > 0,
      ...(tree !== undefined ? { tree } : {}),
      ...(treeTimedOut ? { treeUnavailable: true } : {}),
    });
    const toolSpecs = tools.map((t) => t.spec);
    const knownSecrets = (await deps.getKnownSecrets?.().catch(() => [])) ?? [];
    const toolContext: ChatToolContext = {
      signal,
      knownSecrets,
      ...(terminal ? { terminal: terminal.reader } : {}),
    };
    const history: ProviderMessage[] = await buildHistory(chat.messages, {
      model,
      knownSecrets,
      supportsImages: modelInfo.supportsImages,
      toolsOffered: toolSpecs.length > 0,
      readAttachment: (id) => attachments.readBytes(id),
    });

    // S4.4: the loop. The stuck-loop guard counts consecutive steps with the same signature (see `stepSignature`).
    let lastSignature: string | undefined;
    let repeats = 0;
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const messageId = crypto.randomUUID();
      await emit({ type: 'assistant_start', messageId, model });
      // One per assistant step: edits staged or written by this step's tool calls are attributed to its message.
      const stepChanges =
        canEdit && project && deps.changes
          ? trackChanges(
              deps.changes.tools({
                chatId,
                projectId: project.id,
                projectRoot: project.rootPath,
                messageId,
                turnId,
                mode: editMode,
              }),
            )
          : undefined;

      let text = '';
      const toolCalls: ToolCall[] = [];
      let providerMeta: unknown;
      let usage: Usage | undefined;
      let failure: { status: 'stopped' } | { status: 'error'; error: ApiErrorInfo } | undefined;

      try {
        const stream = provider.stream(
          {
            model,
            system,
            messages: history,
            ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
            ...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {}),
          },
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
        ...(step === 0 && firstNotice !== undefined ? { notice: firstNotice } : {}),
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

      const toolsOffered = toolSpecs.length > 0;
      if (toolsOffered) {
        history.push({
          role: 'assistant',
          text,
          toolCalls,
          ...(providerMeta !== undefined ? { providerMeta } : {}),
        });
      }
      const flattened: string[] = text.length > 0 ? [text] : [];
      const entries: { name: string; args: string; ok: boolean; output: string }[] = [];
      // A READ AUTHORIZES WRITES ONLY FROM THE NEXT MODEL STEP (invariant): the model wrote every call of this step
      // before any of their results existed, so a write here can't be based on what a read here returned. Reads are
      // collected for the whole step (`commitReads`) and recorded only once it is over (`endStep`, below), before the
      // next model request. Until then a sibling `write_file` or `delete_file` meets the record as it was before the
      // step: refused as unread without one, refused as stale when the user changed the file since; and a sibling
      // `edit_file` can't have a stale record refreshed for it either. Otherwise the model, with older content or none,
      // would overwrite the user's newer bytes.
      try {
        for (const call of toolCalls) {
          stepChanges?.reset();
          const { message: toolMessage, kept } = await runTool(call, messageId, tools, toolContext, emit, stepChanges);
          const written = stepChanges?.lastWrite();
          try {
            await chats.appendMessage(chatId, toolMessage);
          } catch (err) {
            if (!written) throw err;
            // STOP NEVER HIDES A WRITE, a failed transcript save included: the client still gets the write's real
            // result and the batch update, the result is held in memory (`recordHeld` appends it before the next turn
            // replays the history), and the run ends with the storage error. Its reads are not recorded (the rule
            // below): a held result is not in the chat yet and may never get there (a retry that truncates its attempt
            // drops it; a restart loses it, and the call is then replayed as "Interrupted").
            unrecorded.set(chatId, [...(unrecorded.get(chatId) ?? []), toolMessage]);
            await emit({ type: 'tool_result', message: toolMessage });
            await emit({ type: 'auto_batch_updated', batchId: written.batchId });
            throw err;
          }
          // A READ IS RECORDED ONLY WHEN ITS CONTENT REACHED THE MODEL: only now, with the kept result in the chat,
          // do the call's reads join the step's, to count as seen once the step is over (the rule above). A result
          // that failed to save is replayed as "Interrupted" (it throws above), so its reads must not let a later
          // write pass the stale-read guard.
          if (kept) stepChanges?.commitReads();
          await emit({ type: 'tool_result', message: toolMessage });
          const staged = stepChanges?.lastStage();
          if (staged) await emit({ type: 'changes_updated', messageId, changes: staged.summary });
          if (written) await emit({ type: 'auto_batch_updated', batchId: written.batchId });
          if (toolsOffered) history.push({ role: 'tool', toolCallId: call.id, content: toolMessage.output });
          else flattened.push(flattenToolCall(call, toolMessage));
          entries.push({ name: call.name, args: call.argsJson, ok: toolMessage.ok, output: toolMessage.output });
        }
      } finally {
        // The step is over, also when it ended early: the reads whose results reached the chat are recorded; those of a
        // call whose result couldn't be saved never joined them (the call is replayed as "Interrupted").
        stepChanges?.endStep();
      }
      if (!toolsOffered) {
        // No tool definitions were sent, so providers would reject tool content: replay it as plain text, as buildHistory does.
        const merged = flattened.join('\n\n');
        const prev = history.at(-1);
        if (prev?.role === 'assistant') {
          prev.text = `${prev.text}\n\n${merged}`;
          delete prev.providerMeta;
        } else history.push({ role: 'assistant', text: merged, toolCalls: [] });
      }
      if (signal.aborted) return; // S4.5: stopped during/after the tools; results above are all persisted

      const sig = stepSignature(entries);
      repeats = sig === lastSignature ? repeats + 1 : 1;
      lastSignature = sig;
      if (repeats >= MAX_REPEATED_TOOL_STEPS) {
        await emit({ type: 'error', error: errorInfo('tool_loop_detected') });
        return;
      }
    }

    await emit({ type: 'error', error: errorInfo('max_steps_reached') });
  }

  /**
   * Appends the held results of earlier writes (`unrecorded`) and returns the chat. A result whose assistant message is
   * gone (a retry truncated that attempt after undoing it) or that the chat already holds is dropped. Throws, keeping
   * what is still unappended, when an append fails.
   */
  async function recordHeld(chatId: Id): Promise<Chat> {
    const chat = await chats.get(chatId);
    const held = unrecorded.get(chatId) ?? [];
    while (held.length > 0) {
      const m = held[0] as ToolMessage;
      const owner = chat.messages.some((x) => x.role === 'assistant' && x.toolCalls.some((c) => c.id === m.toolCallId));
      const present = chat.messages.some((x) => x.id === m.id);
      if (owner && !present) {
        await chats.appendMessage(chatId, m);
        chat.messages.push(m);
      }
      held.shift();
    }
    unrecorded.delete(chatId);
    return chats.get(chatId);
  }

  /** Stop before any model call: records the same empty `stopped` assistant message a stop at stream start does. */
  async function stopBeforeModel(
    chatId: Id,
    model: string,
    emit: Emit,
    state: RunState,
    notice: string | undefined,
  ): Promise<void> {
    const messageId = crypto.randomUUID();
    await emit({ type: 'assistant_start', messageId, model });
    const assistant: AssistantMessage = {
      id: messageId,
      role: 'assistant',
      createdAt: now().toISOString(),
      model,
      text: '',
      toolCalls: [],
      status: 'stopped',
      ...(notice !== undefined ? { notice } : {}),
    };
    await chats.appendMessage(chatId, assistant);
    state.modified = true;
    await emit({ type: 'assistant_end', message: assistant });
  }

  /**
   * Runs one tool call (emitting `tool_call` first). Never throws. `kept` is true when the message carries the tool's
   * own result; the caller commits the call's reads only once that result is in the chat, and records them as seen
   * when the step is over.
   */
  async function runTool(
    call: ToolCall,
    messageId: Id,
    tools: OfferedTool[],
    ctx: ChatToolContext,
    emit: Emit,
    changes?: TrackedChanges,
  ): Promise<{ message: ToolMessage; kept: boolean }> {
    const { signal } = ctx;
    const knownSecrets = ctx.knownSecrets ?? [];
    await emit({ type: 'tool_call', messageId, toolCall: call });
    const started = now().getTime();

    let kept = false;
    const execute = async (): Promise<{ ok: boolean; output: string; summary: string }> => {
      if (signal.aborted) return interrupted();
      const tool = tools.find((t) => t.spec.name === call.name);
      if (!tool) {
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
        const result = await tool.run(args, ctx, changes);
        // STOP NEVER HIDES A WRITE (invariant): a call that changed a project file keeps its real result even when
        // Stop arrived meanwhile, so the stored history (and the model, on the next turn) says what reached the disk.
        // Any other result that arrives after a stop is replaced, so what is stored never depends on a race.
        // A READ IS RECORDED ONLY WHEN ITS CONTENT REACHED THE MODEL (invariant): the reads are committed only with a
        // result that is kept (`kept`), only after that result was appended to the chat, and they count as seen only
        // once the step is over (the caller). A read replaced by "Interrupted", or whose result couldn't be saved (the
        // model is then told "Interrupted"), must not count as seen, or a later overwrite based on older content would
        // pass the stale-read guard and undo the user's edit.
        if (changes?.lastWrite() || !signal.aborted) {
          kept = true;
          return result;
        }
        return interrupted();
      } catch {
        // `Tool.run` must not throw; if it does, report it to the model without leaking details.
        return { ok: false, output: `The "${call.name}" tool failed unexpectedly.`, summary: 'Tool failed' };
      }
    };

    const raw = await execute();
    // Backstop for the tools' own redaction (plan K1): nothing secret-looking is emitted, stored or replayed.
    const output = redactSecrets(raw.output, { known: knownSecrets });
    const result = {
      ok: raw.ok,
      output: output.count > 0 ? `${output.text}\n${redactionNote(output.count)}` : output.text,
      summary: redactSecrets(raw.summary, { known: knownSecrets }).text,
    };
    const message: ToolMessage = {
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
    return { message, kept };
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
      const latest = await chats.get(input.chatId);
      if (latest.title !== NEW_CHAT_TITLE) return; // the user renamed it meanwhile
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
