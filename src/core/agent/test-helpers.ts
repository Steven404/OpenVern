// In-memory fakes of the S1/S2/S3 services, for testing the agent in isolation (test-only; not exported from index.ts).

import { REASONING_EFFORTS } from '@shared/constants';
import type { AgentEvent } from '@shared/events';
import type {
  AttachmentRef,
  Chat,
  ChatSummary,
  ChatUsage,
  Id,
  Message,
  ModelInfo,
  Project,
  ProjectListItem,
  ReasoningEffort,
} from '@shared/types';
import { CoreError } from '../errors';
import { createFakeProvider, type FakeProvider, type FakeScript } from '../providers/fake';
import { addUsage, totalsFromMessages, type UsageTotals, usageFromMessages } from '../storage/schemas';
import type { Tool, ToolContext, ToolResult } from '../tools/types';
import type {
  AgentService,
  AttachmentsService,
  ChangesService,
  ChatsService,
  ModelCatalog,
  ProjectsService,
  RunTurnInput,
  StoredAttachment,
} from '../types';
import { type AgentServiceDeps, createAgentService } from './loop';

const clone = <T>(v: T): T => structuredClone(v);

/** Deterministic clock: every call returns the next second. */
export function createClock(start = Date.UTC(2026, 9, 31, 12, 0, 0)): () => Date {
  let t = start;
  return () => {
    t += 1000;
    return new Date(t);
  };
}

export interface FakeChats extends ChatsService {
  readonly store: Map<Id, Chat>;
}

/** F1: mirrors storage's cumulative counters, so `chat_updated.usage` is populated in agent tests. */
export function createFakeChats(now: () => Date = createClock()): FakeChats {
  const store = new Map<Id, Chat>();
  const totals = new Map<Id, UsageTotals>();
  const need = (id: Id): Chat => {
    const c = store.get(id);
    if (!c) throw new CoreError('not_found');
    return c;
  };
  const usageFor = (c: Chat): ChatUsage => {
    let t = totals.get(c.id);
    if (!t) {
      t = totalsFromMessages(c.messages);
      totals.set(c.id, t);
    }
    return usageFromMessages(c.messages, t);
  };
  const summary = (c: Chat): ChatSummary => ({
    id: c.id,
    projectId: c.projectId,
    title: c.title,
    model: c.model,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    archived: c.archived,
    usage: usageFor(c),
    effort: c.effort,
  });
  return {
    store,
    async list() {
      return [...store.values()].map(summary);
    },
    async get(id) {
      return clone(need(id));
    },
    async create({ projectId, model }) {
      const ts = now().toISOString();
      const chat: Chat = {
        id: crypto.randomUUID(),
        projectId,
        title: 'New chat',
        model,
        createdAt: ts,
        updatedAt: ts,
        archived: false,
        usage: { contextTokens: 0, promptTokens: 0, completionTokens: 0, costUsd: null, requests: 0 },
        effort: null,
        messages: [],
      };
      store.set(chat.id, chat);
      totals.set(chat.id, { promptTokens: 0, completionTokens: 0, costUsd: null, requests: 0 });
      return clone(chat);
    },
    async update(id, patch) {
      const c = need(id);
      if (patch.title !== undefined) c.title = patch.title;
      if (patch.projectId !== undefined) c.projectId = patch.projectId;
      if (patch.model !== undefined && patch.model !== c.model) {
        c.model = patch.model;
        c.updatedAt = now().toISOString();
      }
      // F3: mirrors storage's effort branch.
      if (patch.effort !== undefined && patch.effort !== c.effort) {
        c.effort = patch.effort;
        c.updatedAt = now().toISOString();
      }
      if (patch.archived !== undefined) c.archived = patch.archived;
      return summary(c);
    },
    async remove(id) {
      store.delete(id);
    },
    async appendMessage(id, message: Message) {
      const c = need(id);
      // Read the counters before the push so the new message is not counted twice.
      const before = usageFor(c);
      c.messages.push(clone(message));
      if (message.role === 'assistant' && message.usage) totals.set(id, addUsage(before, message.usage));
      c.usage = usageFor(c);
      c.updatedAt = now().toISOString();
      return summary(c);
    },
    async truncateAfterLastUser(id) {
      const c = need(id);
      const lastUser = c.messages.findLastIndex((m) => m.role === 'user');
      if (lastUser >= 0) c.messages.length = lastUser + 1;
      c.usage = usageFor(c);
      return clone(c);
    },
    async detachProject(projectId) {
      for (const c of store.values()) if (c.projectId === projectId) c.projectId = null;
    },
  };
}

export interface FakeAttachments extends AttachmentsService {
  /** Test helper: stores an attachment and returns its ref. */
  add(input: { name: string; content: string | Uint8Array; mime?: string; kind?: 'text' | 'image' }): AttachmentRef;
  readonly bound: Map<Id, Id>;
}

export function createFakeAttachments(): FakeAttachments {
  const refs = new Map<Id, StoredAttachment>();
  const bytes = new Map<Id, Uint8Array>();
  const bound = new Map<Id, Id>();
  const need = (id: Id): StoredAttachment => {
    const a = refs.get(id);
    if (!a) throw new CoreError('not_found');
    return a;
  };
  return {
    bound,
    add({ name, content, mime, kind }) {
      const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const k = kind ?? 'text';
      const ref: AttachmentRef = {
        id: crypto.randomUUID(),
        name,
        mime: mime ?? (k === 'image' ? 'image/png' : 'text/plain'),
        size: data.byteLength,
        kind: k,
      };
      refs.set(ref.id, { ...ref, chatId: null, createdAt: new Date(0).toISOString() });
      bytes.set(ref.id, data);
      return ref;
    },
    async create({ name, bytes: data }) {
      return this.add({ name, content: data });
    },
    async get(id) {
      return clone(need(id));
    },
    async readBytes(id) {
      need(id);
      const b = bytes.get(id);
      if (!b) throw new CoreError('not_found');
      return b;
    },
    async bindToChat(ids, chatId) {
      const out: AttachmentRef[] = [];
      for (const id of ids) {
        const a = need(id);
        if (a.chatId && a.chatId !== chatId) throw new CoreError('conflict');
        a.chatId = chatId;
        bound.set(id, chatId);
        out.push({ id: a.id, name: a.name, mime: a.mime, size: a.size, kind: a.kind });
      }
      return out;
    },
    async remove(id) {
      refs.delete(id);
      bytes.delete(id);
    },
    async removeForChat() {},
    async cleanupOrphans() {
      return 0;
    },
  };
}

export function createFakeProjects(projects: Project[] = []): ProjectsService & { add(p: Project): void } {
  const store = new Map(projects.map((p) => [p.id, p]));
  return {
    add: (p) => void store.set(p.id, p),
    async list() {
      return [...store.values()].map((p): ProjectListItem => ({ ...p, chatCount: 0 }));
    },
    async get(id) {
      const p = store.get(id);
      if (!p) throw new CoreError('not_found');
      return clone(p);
    },
    async create({ rootPath, name }) {
      const p: Project = {
        id: crypto.randomUUID(),
        name: name ?? rootPath,
        rootPath,
        createdAt: new Date(0).toISOString(),
      };
      store.set(p.id, p);
      return p;
    },
    async rename(id, name) {
      const p = store.get(id);
      if (!p) throw new CoreError('not_found');
      p.name = name;
      return clone(p);
    },
    async remove(id) {
      store.delete(id);
    },
  };
}

export function model(
  id: string,
  caps: {
    tools?: boolean;
    images?: boolean;
    reasoning?: boolean;
    /** F3: levels the model accepts. Default: every level when `reasoning` is true, none otherwise. */
    efforts?: ReasoningEffort[];
    defaultEffort?: ReasoningEffort;
  } = {},
): ModelInfo {
  const reasoning = caps.reasoning ?? false;
  const efforts = caps.efforts ? [...caps.efforts] : reasoning ? [...REASONING_EFFORTS] : [];
  return {
    id,
    name: id,
    contextLength: 100_000,
    supportsTools: caps.tools ?? true,
    supportsImages: caps.images ?? false,
    supportsReasoning: reasoning,
    ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
    ...(caps.defaultEffort !== undefined ? { defaultEffort: caps.defaultEffort } : {}),
    promptPricePerMTok: null,
    completionPricePerMTok: null,
  };
}

export function createFakeModels(list: ModelInfo[]): ModelCatalog {
  return {
    async list() {
      return clone(list);
    },
    resetFailure() {},
    async get(id) {
      return clone(list.find((m) => m.id === id) ?? model(id));
    },
  };
}

/** A tool whose args must be an object with a string `path`. */
export function createFakeTool(
  name: string,
  handler: (args: { path: string }, ctx: ToolContext) => Promise<ToolResult> | ToolResult = ({ path }) => ({
    ok: true,
    output: `contents of ${path}`,
    summary: path,
  }),
): Tool & { calls: { args: unknown; ctx: ToolContext }[] } {
  const calls: { args: unknown; ctx: ToolContext }[] = [];
  return {
    calls,
    spec: {
      name,
      description: `fake ${name}`,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    async run(rawArgs, ctx) {
      calls.push({ args: rawArgs, ctx });
      const path = (rawArgs as { path?: unknown } | null)?.path;
      if (typeof path !== 'string')
        return { ok: false, output: 'Invalid arguments: "path" must be a string.', summary: 'Invalid arguments' };
      return handler({ path }, ctx);
    },
  };
}

export const PROJECT: Project = {
  id: 'proj-1',
  name: 'demo',
  rootPath: '/home/me/demo',
  createdAt: new Date(0).toISOString(),
};

export interface HarnessOptions {
  script: FakeScript;
  models?: ModelInfo[];
  tools?: Tool[];
  /** Create the chat inside the demo project (default) or as a loose chat. */
  project?: boolean;
  chatModel?: string;
  titleTimeoutMs?: number;
  treeTimeoutMs?: number;
  renderTree?: AgentServiceDeps['renderTree'];
  /** Reuse a provider (e.g. for custom delay). */
  provider?: FakeProvider;
  /** A change-set service; enables the edit tools for project chats with a tools-capable model. */
  changes?: ChangesService;
  /** Real folder for the project (default: the fictional demo path). */
  projectRoot?: string;
}

export interface Harness {
  agent: AgentService;
  chats: FakeChats;
  attachments: FakeAttachments;
  provider: FakeProvider;
  tools: Tool[];
  chatId: Id;
  renderTreeCalls: { root: string; opts: { depth: number; maxEntries: number } }[];
  /** Runs a turn, collecting events. Resolves when `runTurn` does. */
  run(input?: Partial<RunTurnInput>): Promise<AgentEvent[]>;
  /** Persisted messages of the chat. */
  messages(): Message[];
}

export const MODEL = 'test/model';

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  const now = createClock();
  const chats = createFakeChats(now);
  const attachments = createFakeAttachments();
  const projects = createFakeProjects([opts.projectRoot ? { ...PROJECT, rootPath: opts.projectRoot } : PROJECT]);
  const models = createFakeModels(opts.models ?? [model(MODEL, { tools: true, images: true })]);
  const provider = opts.provider ?? createFakeProvider({ script: opts.script, delayMs: 0 });
  const tools = opts.tools ?? [createFakeTool('read_file')];
  const renderTreeCalls: Harness['renderTreeCalls'] = [];
  const chat = await chats.create({
    projectId: opts.project === false ? null : PROJECT.id,
    model: opts.chatModel ?? MODEL,
  });

  const agent = createAgentService({
    chats,
    attachments,
    projects,
    models,
    provider,
    getProjectTools: () => tools,
    ...(opts.changes ? { changes: opts.changes } : {}),
    renderTree:
      opts.renderTree ??
      (async (root, o) => {
        renderTreeCalls.push({ root, opts: { depth: o.depth, maxEntries: o.maxEntries } });
        return 'src/\n  index.ts\nREADME.md';
      }),
    now,
    ...(opts.titleTimeoutMs !== undefined ? { titleTimeoutMs: opts.titleTimeoutMs } : {}),
    ...(opts.treeTimeoutMs !== undefined ? { treeTimeoutMs: opts.treeTimeoutMs } : {}),
  });

  return {
    agent,
    chats,
    attachments,
    provider,
    tools,
    chatId: chat.id,
    renderTreeCalls,
    async run(input = {}) {
      const events: AgentEvent[] = [];
      await agent.runTurn({
        chatId: chat.id,
        newUserMessage: { text: 'Hello there', attachmentIds: [] },
        model: MODEL,
        signal: new AbortController().signal,
        emit: (e) => void events.push(e),
        ...input,
      });
      return events;
    },
    messages: () => clone(chats.store.get(chat.id)?.messages ?? []),
  };
}

/** Event type sequence with consecutive `text_delta`s collapsed to `text_delta*`. */
export function shape(events: AgentEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === 'text_delta' && out.at(-1) === 'text_delta*') continue;
    out.push(e.type === 'text_delta' ? 'text_delta*' : e.type);
  }
  return out;
}
