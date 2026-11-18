// In-memory `ApiClient` for UI work without a server (`VITE_API=mock`). Seeded with the design's sample data;
// streams a fake turn (text → read_file → text with a code block) for any message.

import {
  type ApplyChangesBody,
  type ApplyChangesResponse,
  CHAT_PROJECT_CHANGED,
  EDIT_MODE_CHANGED,
  PROJECT_NOT_IN_GIT,
  type UndoBatchResponse,
} from '@shared/api';
import { sniffAttachmentBytes } from '@shared/attachment-sniff';
import { DEFAULT_MODEL, LIMITS, NEW_CHAT_TITLE } from '@shared/constants';
import { type ErrorCode, errorInfo } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import { SAMPLE_MODELS, SAMPLE_USAGE } from '@shared/sample-data';
import type {
  AppliedBatch,
  AssistantMessage,
  AttachmentRef,
  BatchUndo,
  Chat,
  ChatChanges,
  ChatSummary,
  ChatUsage,
  EditMode,
  FileChange,
  HomeFileListing,
  Id,
  Message,
  ModelInfo,
  Project,
  ProjectFileContent,
  ProjectFileListing,
  ProjectFileSearchResult,
  ProjectListItem,
  PublicSettings,
  ReasoningEffort,
  ToolCall,
  ToolMessage,
  Usage,
  UserMessage,
} from '@shared/types';
import { type ApiClient, ApiError } from './api-client';
import {
  acceptedOnly,
  sampleAutoBatch,
  sampleFileContent,
  sampleFolder,
  sampleProposal,
  sampleSearch,
  summarize,
} from './mock-changes';

export interface MockApiClientOptions {
  /** Pause between streamed events, in ms. Default 30; use 0 in tests. */
  delayMs?: number;
  /** Start with an OpenRouter key configured. Default true. */
  keyConfigured?: boolean;
  /** Start with the design's sample projects and chats. Default true. */
  seed?: boolean;
}

interface StoredAttachment {
  ref: AttachmentRef;
  blob: Blob;
  url?: string;
  bound: boolean;
}

const fail = (code: ErrorCode, status: number, message?: string): never => {
  throw new ApiError(errorInfo(code, message), status);
};

const clone = <T>(v: T): T => structuredClone(v);

/** A sample folder, failing like the server (`resolveListedDir`): 404 for a missing path, 400 for a file. */
function mockFolder(dir: string): ProjectFileListing {
  const listing = sampleFolder(dir);
  if (listing === 'missing') return fail('not_found', 404, `Folder not found: ${dir}`);
  if (listing === 'file') return fail('invalid_request', 400, `${dir} is not a folder.`);
  return listing;
}

/** A sample search, with the server's query rules (`searchAt`): empty and overlong queries are 400. */
function mockSearch(query: string): ProjectFileSearchResult {
  const q = query.trim();
  if (q === '') return fail('invalid_request', 400, 'Missing search text.');
  if (q.toLowerCase().length > LIMITS.fileSearchMaxQueryLength)
    return fail('invalid_request', 400, 'The search text is too long.');
  return sampleSearch(q);
}
const now = () => new Date().toISOString();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

// ── F1: context usage, mirroring the server's storage rules (plan §4.4) ───────────────────────

/** Per-chat cumulative counters; they survive a retry's truncation. */
type UsageTotals = Omit<ChatUsage, 'contextTokens'>;

const EMPTY_USAGE: ChatUsage = { contextTokens: 0, promptTokens: 0, completionTokens: 0, costUsd: null, requests: 0 };

const addUsage = (totals: UsageTotals, usage: Usage): UsageTotals => ({
  promptTokens: totals.promptTokens + usage.promptTokens,
  completionTokens: totals.completionTokens + usage.completionTokens,
  costUsd: usage.costUsd === undefined ? totals.costUsd : (totals.costUsd ?? 0) + usage.costUsd,
  requests: totals.requests + 1,
});

const totalsFrom = (messages: readonly Message[]): UsageTotals =>
  messages.reduce<UsageTotals>(
    (totals, m) => (m.role === 'assistant' && m.usage ? addUsage(totals, m.usage) : totals),
    { promptTokens: 0, completionTokens: 0, costUsd: null, requests: 0 },
  );

const usageFrom = (messages: readonly Message[], totals: UsageTotals): ChatUsage => {
  const latest = messages.findLast((m): m is AssistantMessage => m.role === 'assistant' && m.usage !== undefined);
  return { contextTokens: latest?.usage ? latest.usage.promptTokens + latest.usage.completionTokens : 0, ...totals };
};

const SAMPLE_CODE = [
  '```ts',
  'while (true) {',
  '  const reply = await model.send(messages)',
  '  messages.push(reply)',
  '  if (!reply.toolCalls.length) break',
  '  for (const call of reply.toolCalls) {',
  '    messages.push(await tools.run(call))',
  '  }',
  '}',
  '```',
].join('\n');

/** A stored batch. `projectId`: the project an auto turn wrote into; never sent (as on the server). */
type MockBatch = AppliedBatch & { projectId?: Id };

/** The server's messages for an undo it refuses (`POST …/batches/:batchId/undo`). */
const UNDO_RUNNING = 'Wait for the response to finish before undoing edits.';
const UNDO_NO_PROJECT = 'This chat has no project to write to.';
const UNDO_GONE = 'These edits can no longer be undone.';

/** Must match `INTERRUPTED_OUTPUT` in `src/core/agent/history.ts` (the renderer doesn't import `@core`). */
const INTERRUPTED_OUTPUT = 'Interrupted: the run was stopped before this tool finished.';

export class MockApiClient implements ApiClient {
  private readonly delayMs: number;
  private apiKey: string | null;
  private lastModel: string | null = null;
  private lastEffort: ReasoningEffort | null = null;
  private projects: Project[] = [];
  private chats: Chat[] = [];
  private attachments = new Map<Id, StoredAttachment>();
  private running = new Set<Id>();
  private changes = new Map<Id, { revision: number; messageId: Id; files: FileChange[] } | null>();
  private applied = new Map<Id, MockBatch[]>();
  /** Bumps whenever the chat changed project files (apply, auto write, undo), like the server's `diskSeq`. */
  private diskSeq = new Map<Id, number>();
  /** Projects whose folder is not in a Git work tree (`inGitRepo: false`). */
  private noGit = new Set<Id>();
  private usageTotals = new Map<Id, UsageTotals>();

  constructor(opts: MockApiClientOptions = {}) {
    this.delayMs = opts.delayMs ?? 30;
    this.apiKey = (opts.keyConfigured ?? true) ? 'sk-or-v1-mock0000000000000000a1b2' : null;
    if (opts.seed ?? true) this.seed();
  }

  // ── settings ──────────────────────────────────────────────────────────────

  private publicSettings(): PublicSettings {
    const k = this.apiKey;
    return {
      openRouter: { configured: k !== null, keyHint: k ? `${k.slice(0, 9)}…${k.slice(-4)}` : null },
      lastModel: this.lastModel,
      lastEffort: this.lastEffort,
    };
  }

  async health() {
    return { ok: true as const, version: '0.0.0-mock', mode: 'dev' as const };
  }
  async getSettings() {
    return this.publicSettings();
  }
  async setOpenRouterKey(apiKey: string) {
    await this.pause(400);
    if (!apiKey.trim().startsWith('sk-or-')) fail('invalid_api_key', 400);
    this.apiKey = apiKey.trim();
    return this.publicSettings();
  }
  async removeOpenRouterKey() {
    this.apiKey = null;
    return this.publicSettings();
  }
  async updateSettings(patch: { lastModel?: string; lastEffort?: ReasoningEffort | null }) {
    if (patch.lastModel !== undefined) this.lastModel = patch.lastModel;
    if (patch.lastEffort !== undefined) this.lastEffort = patch.lastEffort;
    return this.publicSettings();
  }
  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) fail('no_api_key', 400);
    return clone(SAMPLE_MODELS);
  }

  // ── projects ──────────────────────────────────────────────────────────────

  async listProjects(): Promise<ProjectListItem[]> {
    return this.projects
      .map((p) => ({
        ...clone(p),
        chatCount: this.chats.filter((c) => c.projectId === p.id).length,
        inGitRepo: !this.noGit.has(p.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  /** Test hook: the folder of `projectId` gains or loses its repository (the server checks it on every list). */
  setProjectInGitRepo(projectId: Id, inGitRepo: boolean) {
    if (inGitRepo) this.noGit.delete(projectId);
    else this.noGit.add(projectId);
  }
  /** Like the server's Git check: Auto in a folder outside Git needs the UI to have shown it outside Git. */
  private checkAutoGit(projectId: Id, shown: boolean | undefined) {
    if (shown !== false && this.noGit.has(projectId)) fail('conflict', 409, PROJECT_NOT_IN_GIT);
  }
  async createProject(input: { rootPath: string; name?: string }) {
    const raw = input.rootPath.trim();
    if (!raw.startsWith('/') && !raw.startsWith('~')) fail('path_invalid', 400, 'Enter an absolute path to a folder.');
    const rootPath = (raw.startsWith('~') ? `/home/you${raw.slice(1)}` : raw).replace(/\/+$/, '') || '/';
    if (this.projects.some((p) => p.rootPath === rootPath)) fail('conflict', 409, 'This folder is already a project.');
    const project: Project = {
      id: crypto.randomUUID(),
      name: input.name?.trim() || rootPath.split('/').at(-1) || rootPath,
      rootPath,
      createdAt: now(),
    };
    this.projects.push(project);
    return clone(project);
  }
  async renameProject(id: Id, name: string) {
    const p = this.projects.find((x) => x.id === id) ?? fail('not_found', 404, 'Project not found.');
    p.name = name.trim();
    return clone(p);
  }
  async deleteProject(id: Id) {
    this.projects = this.projects.filter((p) => p.id !== id);
    for (const c of this.chats) if (c.projectId === id) c.projectId = null;
  }

  // ── chats ─────────────────────────────────────────────────────────────────

  private chat(id: Id): Chat {
    return this.chats.find((c) => c.id === id) ?? fail('not_found', 404, 'Chat not found.');
  }
  private summary(c: Chat): ChatSummary {
    const { messages, ...s } = c;
    return clone({ ...s, usage: this.usageOf(c.id, messages) });
  }

  /** Totals are created on first use from the stored messages (as storage backfills old chat files). */
  private usageOf(chatId: Id, messages: readonly Message[]): ChatUsage {
    let totals = this.usageTotals.get(chatId);
    if (!totals) {
      totals = totalsFrom(messages);
      this.usageTotals.set(chatId, totals);
    }
    return usageFrom(messages, totals);
  }

  async listChats() {
    return this.chats.map((c) => this.summary(c)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async createChat(input: { projectId: Id | null; model: string; editMode?: EditMode; expectedInGitRepo?: boolean }) {
    if (input.projectId && !this.projects.some((p) => p.id === input.projectId)) fail('not_found', 404);
    if (input.editMode === 'auto' && input.projectId) this.checkAutoGit(input.projectId, input.expectedInGitRepo);
    const t = now();
    const chat: Chat = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: NEW_CHAT_TITLE,
      model: input.model,
      createdAt: t,
      updatedAt: t,
      archived: false,
      usage: { ...EMPTY_USAGE },
      effort: null,
      editMode: input.editMode ?? 'review',
      messages: [],
    };
    this.chats.push(chat);
    this.usageTotals.set(chat.id, { promptTokens: 0, completionTokens: 0, costUsd: null, requests: 0 });
    return clone(chat);
  }
  async getChat(id: Id) {
    return clone(this.chat(id));
  }
  async updateChat(
    id: Id,
    patch: {
      title?: string;
      projectId?: Id | null;
      archived?: boolean;
      editMode?: EditMode;
      expectedEditMode?: EditMode;
      expectedProjectId?: Id | null;
      expectedInGitRepo?: boolean;
    },
  ) {
    // Same rules as `PATCH /chats/:id`. Everything is validated before anything is mutated.
    const c = this.chat(id);
    // A move that names no mode expects Review; any other PATCH that names none is unchecked.
    const expected = patch.expectedEditMode ?? (patch.projectId !== undefined ? 'review' : undefined);
    if (expected !== undefined && expected !== c.editMode) fail('conflict', 409, EDIT_MODE_CHANGED);
    if (patch.expectedProjectId !== undefined && patch.expectedProjectId !== c.projectId)
      fail('conflict', 409, CHAT_PROJECT_CHANGED);
    if (patch.archived !== undefined && this.running.has(id))
      fail('conflict', 409, 'Wait for the response to finish before archiving or unarchiving this chat.');
    // A move (alone or with `archived`) is refused while edits are pending; archiving alone is not.
    if (patch.projectId !== undefined && patch.projectId !== c.projectId && this.changes.get(id))
      fail('conflict', 409, 'Apply or discard the proposed edits first.');
    if (patch.projectId && !this.projects.some((p) => p.id === patch.projectId)) fail('not_found', 404);
    // Turning Auto on in a project, or carrying Auto into another one, checks that folder's Git status.
    const nextProject = patch.projectId !== undefined ? patch.projectId : c.projectId;
    const nextMode = patch.editMode ?? c.editMode;
    const carriesAuto = patch.editMode === 'auto' || (patch.projectId !== undefined && patch.projectId !== c.projectId);
    if (carriesAuto && nextMode === 'auto' && nextProject) this.checkAutoGit(nextProject, patch.expectedInGitRepo);

    if (patch.title !== undefined) c.title = patch.title.trim();
    if (patch.projectId !== undefined) c.projectId = patch.projectId;
    // Any chat can be archived; a move keeps the flag.
    if (patch.archived !== undefined) c.archived = patch.archived;
    // No run check: the turn read its mode when it started, so a change applies from the next turn.
    if (patch.editMode !== undefined) c.editMode = patch.editMode;
    return this.summary(c);
  }
  async deleteChat(id: Id) {
    const c = this.chat(id);
    this.chats = this.chats.filter((x) => x !== c);
    this.changes.delete(id);
    this.applied.delete(id);
    this.diskSeq.delete(id);
    this.usageTotals.delete(id);
    for (const m of c.messages) if (m.role === 'user') for (const a of m.attachments) this.dropAttachment(a.id);
  }

  // ── streaming ─────────────────────────────────────────────────────────────

  sendMessage(
    chatId: Id,
    input: {
      text: string;
      attachmentIds: Id[];
      model: string;
      effort?: ReasoningEffort | null;
      /** Ignored here: the mock never asks for terminal reads (see `answerTerminalRead`). */
      terminal?: boolean;
      expectedEditMode?: EditMode;
      expectedProjectId?: Id | null;
    },
    signal: AbortSignal,
  ) {
    return this.run(chatId, input.model, input.effort, input, signal, input);
  }
  retry(
    chatId: Id,
    input: {
      model: string;
      effort?: ReasoningEffort | null;
      terminal?: boolean;
      expectedEditMode?: EditMode;
      expectedProjectId?: Id | null;
    },
    signal: AbortSignal,
  ) {
    return this.run(chatId, input.model, input.effort, input, signal);
  }

  private async *run(
    chatId: Id,
    model: string,
    effortInput: ReasoningEffort | null | undefined,
    expected: { expectedEditMode?: EditMode; expectedProjectId?: Id | null },
    signal: AbortSignal,
    input?: { text: string; attachmentIds: Id[] },
  ): AsyncIterable<AgentEvent> {
    const chat = this.chat(chatId);
    // Backfill the totals before a retry truncates the messages, so the discarded turn keeps counting.
    this.usageOf(chatId, chat.messages);
    if (this.running.has(chatId)) fail('conflict', 409, 'A reply is already in progress.');
    // Like the server: the turn runs in the mode the UI showed (omitted means Review) and in the project it showed
    // (omitted means unchecked), or not at all (nothing stored, truncated or undone).
    const mode: EditMode = chat.editMode;
    if ((expected.expectedEditMode ?? 'review') !== mode) fail('conflict', 409, EDIT_MODE_CHANGED);
    if (expected.expectedProjectId !== undefined && expected.expectedProjectId !== chat.projectId)
      fail('conflict', 409, CHAT_PROJECT_CHANGED);
    if (!this.apiKey) fail('no_api_key', 400);
    const info = SAMPLE_MODELS.find((m) => m.id === model);
    // F3: the body's effort wins; omitted = the chat's stored effort.
    const effort = effortInput === undefined ? chat.effort : effortInput;
    const refs = (input?.attachmentIds ?? []).map(
      (id) => this.attachments.get(id)?.ref ?? fail('not_found', 404, 'Attachment not found.'),
    );
    if (info && !info.supportsImages && refs.some((r) => r.kind === 'image')) fail('model_no_image_input', 400);

    this.running.add(chatId);
    // The turn uses the mode it checked above for the whole run: a mode change during the run applies from the next
    // turn.
    let turnId: Id;
    let retryNotice: string | undefined;
    try {
      if (input) {
        const user: UserMessage = {
          id: crypto.randomUUID(),
          role: 'user',
          createdAt: now(),
          text: input.text,
          attachments: clone(refs),
        };
        for (const id of input.attachmentIds) {
          const a = this.attachments.get(id);
          if (a) a.bound = true;
        }
        chat.messages.push(user);
        turnId = user.id;
        yield { type: 'user_message', message: clone(user) };
      } else {
        const lastUser = chat.messages.findLastIndex((m) => m.role === 'user');
        turnId = chat.messages[lastUser]?.id ?? '';
        // Like the server: a retry first undoes what the previous attempt wrote, whatever mode the retry runs in.
        const undone = this.undoTurn(chatId, turnId);
        if (undone) {
          yield { type: 'auto_batch_updated', batchId: undone.batchId };
          const n = undone.undo.restored.length;
          retryNotice = `Undid the previous attempt's edits (${n} file${n === 1 ? '' : 's'}).`;
        }
        chat.messages.splice(lastUser + 1);
      }

      const useTools = chat.projectId !== null && (info?.supportsTools ?? true);
      const edit = useTools && input?.text.includes('[mock:edit]') === true;
      const auto = mode === 'auto';
      const steps: { text: string; toolCalls: ToolCall[]; stages?: boolean; writes?: boolean }[] = edit
        ? [
            {
              text: auto ? "I'll make those edits." : "I'll propose those edits.",
              stages: !auto,
              writes: auto,
              toolCalls: sampleProposal().map((f) => ({
                id: `call_${crypto.randomUUID()}`,
                name: f.kind === 'create' ? 'write_file' : 'edit_file',
                argsJson: JSON.stringify({ path: f.path }),
              })),
            },
            {
              text: auto
                ? 'The edits are written. You can undo this turn from its card.'
                : 'The edits are proposed. Review them and apply the ones you want.',
              toolCalls: [],
            },
          ]
        : useTools
          ? [
              {
                text: "I'll start by reading the README.",
                toolCalls: [{ id: `call_${crypto.randomUUID()}`, name: 'read_file', argsJson: '{"path":"README.md"}' }],
              },
              { text: `Here is the core of the loop:\n\n${SAMPLE_CODE}\n\nAdd a step limit early.`, toolCalls: [] },
            ]
          : [
              {
                text: `Here is the core of an agent loop:\n\n${SAMPLE_CODE}\n\nAdd a step limit early.`,
                toolCalls: [],
              },
            ];

      const stopRun = (): never => {
        chat.updatedAt = now();
        throw signal.reason;
      };

      for (const [stepIndex, step] of steps.entries()) {
        if (signal.aborted) stopRun();
        const msg: AssistantMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          createdAt: now(),
          model,
          text: '',
          toolCalls: [],
          status: 'complete',
          // UI-only, on the run's first assistant message: what the retry undid first.
          ...(stepIndex === 0 && retryNotice !== undefined ? { notice: retryNotice } : {}),
        };
        // Like the server's loop: a stop during (or right after) the text keeps the partial reply as `stopped`.
        const stopText = (): never => {
          msg.status = 'stopped';
          chat.messages.push(msg);
          return stopRun();
        };
        yield { type: 'assistant_start', messageId: msg.id, model };
        try {
          for (const delta of step.text.match(/[\s\S]{1,10}/g) ?? []) {
            await this.pause(this.delayMs, signal);
            msg.text += delta;
            yield { type: 'text_delta', messageId: msg.id, delta };
          }
        } catch (err) {
          if (!signal.aborted) throw err;
          stopText();
        }
        if (signal.aborted) stopText();
        msg.toolCalls = step.toolCalls;
        const stepUsage: Usage = { promptTokens: 120, completionTokens: 48 };
        msg.usage = stepUsage;
        chat.messages.push(msg);
        const totals = this.usageTotals.get(chatId);
        this.usageTotals.set(
          chatId,
          totals ? addUsage(totals, stepUsage) : totalsFrom(chat.messages), // the messages now include this step
        );
        chat.usage = this.usageOf(chatId, chat.messages);
        yield { type: 'assistant_end', message: clone(msg) };

        for (const [i, call] of step.toolCalls.entries()) {
          yield { type: 'tool_call', messageId: msg.id, toolCall: clone(call) };
          const started = Date.now();
          try {
            await this.pause(this.delayMs * 8, signal);
          } catch (err) {
            if (!signal.aborted) throw err;
            // This call and every later call of the step are recorded as interrupted.
            for (const c of step.toolCalls.slice(i)) {
              chat.messages.push({
                id: crypto.randomUUID(),
                role: 'tool',
                createdAt: now(),
                toolCallId: c.id,
                name: c.name,
                ok: false,
                output: INTERRUPTED_OUTPUT,
                summary: 'Interrupted',
                durationMs: Date.now() - started,
              });
            }
            stopRun();
          }
          if (step.writes) {
            const file = sampleProposal()[i];
            if (!file) continue;
            const result = this.autoWrite(chatId, chat.projectId, turnId, msg.id, file);
            const tool: ToolMessage = {
              id: crypto.randomUUID(),
              role: 'tool',
              createdAt: now(),
              toolCallId: call.id,
              name: call.name,
              ok: result !== null,
              output:
                result === null
                  ? `Not written: ${file.path} has a proposed edit from an earlier turn waiting for the user's review. Ask the user to apply or discard it first.`
                  : file.kind === 'create'
                    ? `Created ${file.path} (${file.add} lines). Written to disk.`
                    : `Wrote edit to ${file.path}: +${file.add} -${file.del}\nWritten to disk.`,
              summary: file.path,
              durationMs: this.delayMs * 8,
            };
            chat.messages.push(tool);
            yield { type: 'tool_result', message: clone(tool) };
            if (result) yield { type: 'auto_batch_updated', batchId: result };
            continue;
          }
          const staged = step.stages ? sampleProposal().slice(0, i + 1) : null;
          const tool: ToolMessage = {
            id: crypto.randomUUID(),
            role: 'tool',
            createdAt: now(),
            toolCallId: call.id,
            name: call.name,
            ok: true,
            output: staged
              ? `Proposed ${staged[i]?.path}. Proposed, not written yet.`
              : 'File: README.md (3 lines, showing 1-3)\n1\t# OpenVern\n2\t\n3\tA desktop AI app.',
            summary: staged ? (staged[i]?.path ?? '') : 'README.md',
            durationMs: this.delayMs * 8,
          };
          chat.messages.push(tool);
          yield { type: 'tool_result', message: clone(tool) };
          if (staged) {
            const revision = (this.changes.get(chatId)?.revision ?? 0) + 1;
            this.changes.set(chatId, { revision, messageId: msg.id, files: staged });
            yield { type: 'changes_updated', messageId: msg.id, changes: summarize(staged, revision, msg.id) };
          }
        }
      }

      if (signal.aborted) stopRun();
      chat.model = model;
      chat.effort = effort;
      chat.updatedAt = now();
      if (chat.title === NEW_CHAT_TITLE) {
        const first = chat.messages.find((m): m is UserMessage => m.role === 'user');
        chat.title = first?.text.trim().slice(0, 60) || 'Untitled chat';
      }
      yield { type: 'chat_updated', chat: this.summary(chat) };
      yield { type: 'done' };
    } finally {
      this.running.delete(chatId);
    }
  }

  // ── attachments ───────────────────────────────────────────────────────────

  async uploadAttachment(file: File) {
    await this.pause(this.delayMs * 5);
    // Same content sniffing as the server (S1.7): the bytes decide, never `file.type`.
    const sniff = sniffAttachmentBytes(file.name, new Uint8Array(await file.arrayBuffer()));
    if (!sniff.ok) fail(sniff.code, sniff.code === 'file_too_large' ? 413 : 415, sniff.message);
    const ref: AttachmentRef = {
      id: crypto.randomUUID(),
      name: file.name,
      mime: sniff.ok ? sniff.mime : 'text/plain',
      size: file.size,
      kind: sniff.ok ? sniff.kind : 'text',
    };
    this.attachments.set(ref.id, { ref, blob: file, bound: false });
    return clone(ref);
  }

  async deleteAttachment(id: Id) {
    const a = this.attachments.get(id) ?? fail('not_found', 404);
    if (a.bound) fail('conflict', 409, 'This attachment is already part of a message.');
    this.dropAttachment(id);
  }
  attachmentUrl(id: Id) {
    const a = this.attachments.get(id);
    if (!a) return '';
    a.url ??= URL.createObjectURL(a.blob);
    return a.url;
  }
  private dropAttachment(id: Id) {
    const a = this.attachments.get(id);
    if (a?.url) URL.revokeObjectURL(a.url);
    this.attachments.delete(id);
  }

  // ── project files and proposed edits (v0.2) ───────────────────────────────

  async listProjectFiles(projectId: Id, dir = '', signal?: AbortSignal): Promise<ProjectFileListing> {
    await this.pause(this.delayMs, signal);
    this.project(projectId);
    return mockFolder(dir);
  }

  async searchProjectFiles(projectId: Id, query: string, signal?: AbortSignal): Promise<ProjectFileSearchResult> {
    await this.pause(this.delayMs, signal);
    this.project(projectId);
    return mockSearch(query);
  }

  async readProjectFile(projectId: Id, path: string): Promise<ProjectFileContent> {
    await this.pause(this.delayMs);
    this.project(projectId);
    return sampleFileContent(path) ?? fail('not_found', 404, 'That file does not exist.');
  }

  async attachProjectFile(projectId: Id, path: string): Promise<AttachmentRef> {
    const file = await this.readProjectFile(projectId, path);
    return this.attachListed(file);
  }

  async listHomeFiles(dir = '', signal?: AbortSignal): Promise<HomeFileListing> {
    await this.pause(this.delayMs, signal);
    return { ...mockFolder(dir), root: '/home/you' };
  }

  async searchHomeFiles(query: string, signal?: AbortSignal): Promise<ProjectFileSearchResult> {
    await this.pause(this.delayMs, signal);
    return mockSearch(query);
  }

  async readHomeFile(path: string): Promise<ProjectFileContent> {
    await this.pause(this.delayMs);
    return sampleFileContent(path) ?? fail('not_found', 404, 'That file does not exist.');
  }

  async attachHomeFile(path: string): Promise<AttachmentRef> {
    const file = await this.readHomeFile(path);
    return this.attachListed(file);
  }

  private attachListed(file: ProjectFileContent): AttachmentRef {
    if (file.content === null) return fail('unsupported_file', 415);
    const name = file.path.split('/').pop() ?? file.path;
    const ref: AttachmentRef = { id: crypto.randomUUID(), name, mime: 'text/plain', size: file.size, kind: 'text' };
    this.attachments.set(ref.id, { ref, blob: new Blob([file.content], { type: 'text/plain' }), bound: false });
    return clone(ref);
  }

  async getChatChanges(chatId: Id): Promise<ChatChanges> {
    this.chat(chatId);
    return this.chatChanges(chatId);
  }

  async applyChatChanges(chatId: Id, body: ApplyChangesBody): Promise<ApplyChangesResponse> {
    this.chat(chatId);
    if (this.running.has(chatId)) fail('conflict', 409, 'Wait for the reply to finish first.');
    const pending = this.changes.get(chatId) ?? null;
    if (!pending || pending.revision !== body.revision) fail('changes_stale', 409);
    const { written, rejectedHunks, skippedHunks } = acceptedOnly(pending?.files ?? [], body.decisions);
    const batch: MockBatch = {
      id: crypto.randomUUID(),
      appliedAt: now(),
      messageId: pending?.messageId ?? '',
      written,
      rejectedHunks,
      skippedHunks,
      conflicts: [],
      source: 'review',
      undoable: false,
    };
    this.pushBatch(chatId, batch);
    if (written.length > 0) this.bumpDisk(chatId);
    this.changes.set(chatId, null);
    return { batch: this.batchOut(chatId, batch), changes: this.chatChanges(chatId) };
  }

  async discardChatChanges(chatId: Id): Promise<ChatChanges> {
    this.chat(chatId);
    if (this.running.has(chatId)) fail('conflict', 409, 'Wait for the reply to finish first.');
    this.changes.set(chatId, null);
    return this.chatChanges(chatId);
  }

  async undoChatBatch(chatId: Id, batchId: Id): Promise<UndoBatchResponse> {
    const chat = this.chat(chatId);
    const batch = this.applied.get(chatId)?.find((b) => b.id === batchId) ?? fail('not_found', 404, 'Edits not found.');
    // Same order of checks as the route: a running chat first, then the project, then the batch itself.
    if (this.running.has(chatId)) fail('conflict', 409, UNDO_RUNNING);
    if (!chat.projectId || !this.projects.some((p) => p.id === chat.projectId)) fail('conflict', 409, UNDO_NO_PROJECT);
    if (!this.isUndoable(chatId, batch)) fail('conflict', 409, UNDO_GONE);
    this.restore(chatId, batch, 'user');
    return { batch: this.batchOut(chatId, batch), changes: this.chatChanges(chatId) };
  }

  async answerTerminalRead(): Promise<void> {
    // The mock never sends `terminal_read_request`, so no request is ever waiting (the server's 404).
    fail('not_found', 404, 'No terminal read is waiting under that id.');
  }

  private project(id: Id): Project {
    return this.projects.find((p) => p.id === id) ?? fail('not_found', 404);
  }

  private pushBatch(chatId: Id, batch: MockBatch): void {
    // The list keeps the newest 100 batches of both kinds, like the server's change store.
    this.applied.set(chatId, [...(this.applied.get(chatId) ?? []), batch].slice(-100));
  }

  private bumpDisk(chatId: Id): void {
    this.diskSeq.set(chatId, (this.diskSeq.get(chatId) ?? 0) + 1);
  }

  /**
   * Undo is offered for an auto batch that isn't undone, is among the chat's newest `autoUndoTurns` auto batches, and
   * was written into the chat's current project.
   */
  private isUndoable(chatId: Id, batch: MockBatch): boolean {
    if (batch.source !== 'auto' || batch.undo) return false;
    const autos = (this.applied.get(chatId) ?? []).filter((b) => b.source === 'auto');
    if (autos.indexOf(batch) < autos.length - LIMITS.autoUndoTurns) return false;
    return batch.projectId !== undefined && batch.projectId === this.chats.find((c) => c.id === chatId)?.projectId;
  }

  private batchOut(chatId: Id, batch: MockBatch): AppliedBatch {
    const { projectId: _projectId, ...out } = batch;
    return clone({ ...out, undoable: this.isUndoable(chatId, batch) });
  }

  /**
   * One write of an Auto turn: lands in the turn's open auto batch (created on its first write). `null` when the path
   * has a pending Review proposal, which an Auto edit must not build on.
   */
  private autoWrite(chatId: Id, projectId: Id | null, turnId: Id, messageId: Id, file: FileChange): Id | null {
    if (this.changes.get(chatId)?.files.some((f) => f.path === file.path)) return null;
    const batches = this.applied.get(chatId) ?? [];
    let batch = batches.find((b) => b.source === 'auto' && b.turnId === turnId && !b.undo);
    if (!batch) {
      batch = {
        id: crypto.randomUUID(),
        appliedAt: now(),
        messageId,
        written: [],
        rejectedHunks: 0,
        skippedHunks: 0,
        conflicts: [],
        source: 'auto',
        turnId,
        undoable: false,
        ...(projectId ? { projectId } : {}),
      };
      this.pushBatch(chatId, batch);
    }
    batch.written = [...batch.written.filter((f) => f.path !== file.path), clone(file)].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    batch.appliedAt = now();
    this.bumpDisk(chatId);
    return batch.id;
  }

  /** The mock has no disk to differ from what the turn wrote, so every file is restored. */
  private restore(chatId: Id, batch: MockBatch, by: BatchUndo['by']): BatchUndo {
    const undo: BatchUndo = { at: now(), by, restored: batch.written.map((f) => f.path).sort(), skipped: [] };
    batch.undo = undo;
    if (undo.restored.length > 0) this.bumpDisk(chatId);
    return undo;
  }

  /** Before a retry: undo the turn's auto batch that isn't undone yet. */
  private undoTurn(chatId: Id, turnId: Id): { batchId: Id; undo: BatchUndo } | null {
    const batch = this.applied.get(chatId)?.find((b) => b.source === 'auto' && b.turnId === turnId && !b.undo);
    if (!batch) return null;
    return { batchId: batch.id, undo: this.restore(chatId, batch, 'retry') };
  }

  private chatChanges(chatId: Id): ChatChanges {
    const p = this.changes.get(chatId) ?? null;
    return clone({
      pending: p && {
        revision: p.revision,
        messageId: p.messageId,
        files: p.files,
        totalAdd: p.files.reduce((n, f) => n + f.add, 0),
        totalDel: p.files.reduce((n, f) => n + f.del, 0),
      },
      applied: (this.applied.get(chatId) ?? []).map((b) => this.batchOut(chatId, b)),
      diskSeq: this.diskSeq.get(chatId) ?? 0,
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private pause(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      if (ms <= 0) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  private seed() {
    const project = (name: string, rootPath: string): Project => ({
      id: crypto.randomUUID(),
      name,
      rootPath,
      createdAt: minutesAgo(60 * 24 * 7),
    });
    const openvern = project('stefanos-ai-openvern', '/home/you/code/stefanos-ai-openvern');
    const notes = project('Offline Notes App', '/home/you/code/offline-notes');
    const site = project('Portfolio site', '/home/you/code/portfolio');
    this.projects = [openvern, notes, site];
    // One sample folder outside Git, so the Auto warning can be seen.
    this.noGit.add(site.id);

    let age = 0;
    const chat = (projectId: Id, title: string, messages: Message[] = [], model = DEFAULT_MODEL): Chat => {
      age += 45;
      return {
        id: crypto.randomUUID(),
        projectId,
        title,
        model,
        createdAt: minutesAgo(age + 30),
        updatedAt: minutesAgo(age),
        archived: false,
        usage: { ...EMPTY_USAGE },
        effort: null,
        editMode: 'review',
        messages,
      };
    };

    const call: ToolCall = { id: 'call_seed_1', name: 'read_file', argsJson: '{"path":"src/agent/loop.ts"}' };
    const t = minutesAgo(40);
    const turn: Message[] = [
      {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: t,
        text: 'How should the agent loop handle tool calls? I want it simple: send messages, run any tools the model asks for, feed the results back, repeat.',
        attachments: [],
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        createdAt: t,
        model: DEFAULT_MODEL,
        text: "That shape is right. Keep the loop as one function that only stops when the model's reply contains no tool calls.",
        toolCalls: [call],
        status: 'complete',
      },
      {
        id: crypto.randomUUID(),
        role: 'tool',
        createdAt: t,
        toolCallId: call.id,
        name: 'read_file',
        ok: true,
        output: 'File: src/agent/loop.ts (12 lines, showing 1-12)\n1\texport async function runLoop() {\n…',
        summary: 'src/agent/loop.ts',
        durationMs: 200,
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        createdAt: t,
        model: DEFAULT_MODEL,
        text: `${SAMPLE_CODE}\n\nTwo guards are worth adding early: a maximum number of turns, so a confused model can't spin forever, and a confirmation step before any tool that writes to disk.`,
        toolCalls: [],
        status: 'complete',
        usage: SAMPLE_USAGE.ok,
      },
    ];

    /** A one-question, one-reply chat, so the seeded counter has a context figure to show. */
    const exchange = (model: string, question: string, reply: string, usage: Usage): Message[] => {
      const at = minutesAgo(age + 20);
      return [
        { id: crypto.randomUUID(), role: 'user', createdAt: at, text: question, attachments: [] },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          createdAt: at,
          model,
          text: reply,
          toolCalls: [],
          status: 'complete',
          usage,
        },
      ];
    };

    this.chats = [
      chat(openvern.id, 'Agent loop and tool calls', turn),
      chat(
        openvern.id,
        'Streaming replies over SSE',
        exchange(
          DEFAULT_MODEL,
          'How should I stream replies to the UI?',
          'Send `text/event-stream`, one JSON event per line, and close with `done`.',
          SAMPLE_USAGE.high,
        ),
      ),
      chat(openvern.id, 'Settings: what goes in v1'),
      chat(notes.id, 'Sync conflict strategy'),
      chat(
        notes.id,
        'SQLite schema review',
        exchange(
          DEFAULT_MODEL,
          'Have a look at my tables.',
          'Three tables is right; add an index on `notes.updated_at`.',
          SAMPLE_USAGE.full,
        ),
      ),
      chat(
        site.id,
        'Theme toggle transition',
        exchange(
          'openrouter/auto',
          'Can I animate the theme toggle?',
          'Transition colours over 150ms; skip it under reduced motion.',
          SAMPLE_USAGE.unknown,
        ),
        'openrouter/auto',
      ),
    ];

    for (const c of this.chats) {
      c.usage = this.usageOf(c.id, c.messages);
    }

    // One chat in Auto with an undoable auto turn, so the Auto card and the Diff history have something to show.
    const autoChat = this.chats.find((c) => c.title === 'Streaming replies over SSE');
    const autoUser = autoChat?.messages.find((m) => m.role === 'user');
    const autoReply = autoChat?.messages.find((m) => m.role === 'assistant');
    if (autoChat && autoUser && autoReply) {
      autoChat.editMode = 'auto';
      this.pushBatch(autoChat.id, {
        id: crypto.randomUUID(),
        appliedAt: autoReply.createdAt,
        messageId: autoReply.id,
        written: sampleAutoBatch(),
        rejectedHunks: 0,
        skippedHunks: 0,
        conflicts: [],
        source: 'auto',
        turnId: autoUser.id,
        undoable: false,
        ...(autoChat.projectId ? { projectId: autoChat.projectId } : {}),
      });
      this.bumpDisk(autoChat.id);
    }
  }
}
