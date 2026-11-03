// In-memory `ApiClient` for UI work without a server (`VITE_API=mock`). Seeded with the design's sample data;
// streams a fake turn (text → read_file → text with a code block) for any message.

import type { ApplyChangesBody, ApplyChangesResponse } from '@shared/api';
import { sniffAttachmentBytes } from '@shared/attachment-sniff';
import { DEFAULT_MODEL, NEW_CHAT_TITLE } from '@shared/constants';
import { type ErrorCode, errorInfo } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import { SAMPLE_MODELS } from '@shared/sample-data';
import type {
  AssistantMessage,
  AttachmentRef,
  Chat,
  ChatChanges,
  ChatSummary,
  FileChange,
  HomeFileTree,
  Id,
  Message,
  ModelInfo,
  Project,
  ProjectFileContent,
  ProjectFileTree,
  ProjectListItem,
  PublicSettings,
  ToolCall,
  ToolMessage,
  UserMessage,
} from '@shared/types';
import { type ApiClient, ApiError } from './api-client';
import { acceptedOnly, sampleFileContent, sampleFileTree, sampleProposal, summarize } from './mock-changes';

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
const now = () => new Date().toISOString();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

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

/** Must match `INTERRUPTED_OUTPUT` in `src/core/agent/history.ts` (the renderer doesn't import `@core`). */
const INTERRUPTED_OUTPUT = 'Interrupted: the run was stopped before this tool finished.';

export class MockApiClient implements ApiClient {
  private readonly delayMs: number;
  private apiKey: string | null;
  private lastModel: string | null = null;
  private projects: Project[] = [];
  private chats: Chat[] = [];
  private attachments = new Map<Id, StoredAttachment>();
  private running = new Set<Id>();
  private changes = new Map<Id, { revision: number; messageId: Id; files: FileChange[] } | null>();
  private applied = new Map<Id, ChatChanges['applied']>();

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
  async updateSettings(patch: { lastModel?: string }) {
    if (patch.lastModel !== undefined) this.lastModel = patch.lastModel;
    return this.publicSettings();
  }
  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) fail('no_api_key', 400);
    return clone(SAMPLE_MODELS);
  }

  // ── projects ──────────────────────────────────────────────────────────────

  async listProjects(): Promise<ProjectListItem[]> {
    return this.projects
      .map((p) => ({ ...clone(p), chatCount: this.chats.filter((c) => c.projectId === p.id).length }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
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
    const { messages: _messages, ...s } = c;
    return clone(s);
  }

  async listChats() {
    return this.chats.map((c) => this.summary(c)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async createChat(input: { projectId: Id | null; model: string }) {
    if (input.projectId && !this.projects.some((p) => p.id === input.projectId)) fail('not_found', 404);
    const t = now();
    const chat: Chat = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: NEW_CHAT_TITLE,
      model: input.model,
      createdAt: t,
      updatedAt: t,
      messages: [],
    };
    this.chats.push(chat);
    return clone(chat);
  }
  async getChat(id: Id) {
    return clone(this.chat(id));
  }
  async updateChat(id: Id, patch: { title?: string; projectId?: Id | null }) {
    const c = this.chat(id);
    if (patch.title !== undefined) c.title = patch.title.trim();
    if (patch.projectId !== undefined) {
      if (patch.projectId && !this.projects.some((p) => p.id === patch.projectId)) fail('not_found', 404);
      c.projectId = patch.projectId;
    }
    return this.summary(c);
  }
  async deleteChat(id: Id) {
    const c = this.chat(id);
    this.chats = this.chats.filter((x) => x !== c);
    this.changes.delete(id);
    this.applied.delete(id);
    for (const m of c.messages) if (m.role === 'user') for (const a of m.attachments) this.dropAttachment(a.id);
  }

  // ── streaming ─────────────────────────────────────────────────────────────

  sendMessage(chatId: Id, input: { text: string; attachmentIds: Id[]; model: string }, signal: AbortSignal) {
    return this.run(chatId, input.model, signal, input);
  }
  retry(chatId: Id, input: { model: string }, signal: AbortSignal) {
    return this.run(chatId, input.model, signal);
  }

  private async *run(
    chatId: Id,
    model: string,
    signal: AbortSignal,
    input?: { text: string; attachmentIds: Id[] },
  ): AsyncIterable<AgentEvent> {
    const chat = this.chat(chatId);
    if (this.running.has(chatId)) fail('conflict', 409, 'A reply is already in progress.');
    if (!this.apiKey) fail('no_api_key', 400);
    const info = SAMPLE_MODELS.find((m) => m.id === model);
    const refs = (input?.attachmentIds ?? []).map(
      (id) => this.attachments.get(id)?.ref ?? fail('not_found', 404, 'Attachment not found.'),
    );
    if (info && !info.supportsImages && refs.some((r) => r.kind === 'image')) fail('model_no_image_input', 400);

    this.running.add(chatId);
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
        yield { type: 'user_message', message: clone(user) };
      } else {
        const lastUser = chat.messages.findLastIndex((m) => m.role === 'user');
        chat.messages.splice(lastUser + 1);
      }

      const useTools = chat.projectId !== null && (info?.supportsTools ?? true);
      const edit = useTools && input?.text.includes('[mock:edit]') === true;
      const steps: { text: string; toolCalls: ToolCall[]; stages?: boolean }[] = edit
        ? [
            {
              text: "I'll propose those edits.",
              stages: true,
              toolCalls: sampleProposal().map((f) => ({
                id: `call_${crypto.randomUUID()}`,
                name: f.kind === 'create' ? 'write_file' : 'edit_file',
                argsJson: JSON.stringify({ path: f.path }),
              })),
            },
            { text: 'The edits are proposed. Review them and apply the ones you want.', toolCalls: [] },
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

      for (const step of steps) {
        if (signal.aborted) stopRun();
        const msg: AssistantMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          createdAt: now(),
          model,
          text: '',
          toolCalls: [],
          status: 'complete',
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
        msg.usage = { promptTokens: 120, completionTokens: 48 };
        chat.messages.push(msg);
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

  async listProjectFiles(projectId: Id): Promise<ProjectFileTree> {
    await this.pause(this.delayMs);
    this.project(projectId);
    return sampleFileTree();
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

  async listHomeFiles(): Promise<HomeFileTree> {
    await this.pause(this.delayMs);
    return { ...sampleFileTree(), root: '/home/you' };
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
    const batch = {
      id: crypto.randomUUID(),
      appliedAt: now(),
      messageId: pending?.messageId ?? '',
      written,
      rejectedHunks,
      skippedHunks,
      conflicts: [],
    };
    this.applied.set(chatId, [...(this.applied.get(chatId) ?? []), batch]);
    this.changes.set(chatId, null);
    return { batch: clone(batch), changes: this.chatChanges(chatId) };
  }

  async discardChatChanges(chatId: Id): Promise<ChatChanges> {
    this.chat(chatId);
    if (this.running.has(chatId)) fail('conflict', 409, 'Wait for the reply to finish first.');
    this.changes.set(chatId, null);
    return this.chatChanges(chatId);
  }

  private project(id: Id): Project {
    return this.projects.find((p) => p.id === id) ?? fail('not_found', 404);
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
      applied: this.applied.get(chatId) ?? [],
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

    let age = 0;
    const chat = (projectId: Id, title: string, messages: Message[] = []): Chat => {
      age += 45;
      return {
        id: crypto.randomUUID(),
        projectId,
        title,
        model: DEFAULT_MODEL,
        createdAt: minutesAgo(age + 30),
        updatedAt: minutesAgo(age),
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
      },
    ];

    this.chats = [
      chat(openvern.id, 'Agent loop and tool calls', turn),
      chat(openvern.id, 'Streaming replies over SSE'),
      chat(openvern.id, 'Settings: what goes in v1'),
      chat(notes.id, 'Sync conflict strategy'),
      chat(notes.id, 'SQLite schema review'),
      chat(site.id, 'Theme toggle transition'),
    ];
  }
}
