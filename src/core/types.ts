// Core composition contracts (plan §4.8). `createCore` itself is implemented in S5 (`./index.ts`).
// Service signatures were locked by the V0 orchestrator before wave 2 so S1/S2/S4/S5 build against the
// same shapes. Errors: services throw `CoreError` (./errors.ts); providers throw `ProviderError`.

import type { AgentEvent } from '@shared/events';
import type {
  AttachmentRef,
  Chat,
  ChatSummary,
  Id,
  IsoDate,
  Message,
  ModelInfo,
  Project,
  ProjectListItem,
  PublicSettings,
} from '@shared/types';
import type { Provider } from './providers/types';

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface CoreDeps {
  dataDir: string;
  secretStore: SecretStore;
  provider?: Provider; // default: OpenRouter
  mode: 'dev' | 'prod';
}

// ── S1 ──────────────────────────────────────────────────────────────────────────────────────────

export interface SettingsService {
  get(): Promise<PublicSettings>;
  getApiKey(): Promise<string | null>;
  /** Stores only; the route validates the key with the provider first. */
  setApiKey(apiKey: string): Promise<PublicSettings>;
  clearApiKey(): Promise<PublicSettings>;
  update(patch: { lastModel?: string }): Promise<PublicSettings>;
}

export interface ProjectsService {
  /** With `chatCount`, sorted by name (case-insensitive). */
  list(): Promise<ProjectListItem[]>;
  /** Throws `CoreError('not_found')`. */
  get(id: Id): Promise<Project>;
  /** Expands `~`, realpaths, checks readable dir. Throws `path_invalid` or `conflict` (same realpath). */
  create(input: { rootPath: string; name?: string }): Promise<Project>;
  rename(id: Id, name: string): Promise<Project>;
  /** Moves its chats to `projectId: null`. Never touches files on disk. */
  remove(id: Id): Promise<void>;
}

export interface ChatsService {
  /** Sorted by `updatedAt` desc. */
  list(): Promise<ChatSummary[]>;
  /** Throws `CoreError('not_found')`. */
  get(id: Id): Promise<Chat>;
  /** Title `NEW_CHAT_TITLE`, no messages. Throws `not_found` if `projectId` is unknown. */
  create(input: { projectId: Id | null; model: string }): Promise<Chat>;
  /** Bumps `updatedAt` only when `model` changes (renames/moves don't reorder the sidebar). */
  update(id: Id, patch: { title?: string; projectId?: Id | null; model?: string }): Promise<ChatSummary>;
  /** Deletes the chat file and its index entry (attachments are removed by the caller). */
  remove(id: Id): Promise<void>;
  /** Appends and bumps `updatedAt`. Returns the new summary. */
  appendMessage(chatId: Id, message: Message): Promise<ChatSummary>;
  /** Drops every message after the last user message (for retry). Returns the updated chat. */
  truncateAfterLastUser(chatId: Id): Promise<Chat>;
  /** Re-homes every chat of `projectId` to `projectId: null` (used by `ProjectsService.remove`). */
  detachProject(projectId: Id): Promise<void>;
}

export interface StoredAttachment extends AttachmentRef {
  chatId: Id | null;
  createdAt: IsoDate;
}

export interface AttachmentsService {
  /** Sniffs type, enforces `LIMITS`. Throws `unsupported_file` / `file_too_large`. */
  create(input: { name: string; bytes: Uint8Array }): Promise<AttachmentRef>;
  /** Throws `CoreError('not_found')`. */
  get(id: Id): Promise<StoredAttachment>;
  readBytes(id: Id): Promise<Uint8Array>;
  /** Throws `not_found` for unknown ids, `conflict` if one is bound to another chat. Idempotent per chat. */
  bindToChat(ids: Id[], chatId: Id): Promise<AttachmentRef[]>;
  /** Unbound only; bound → `conflict`. */
  remove(id: Id): Promise<void>;
  removeForChat(chatId: Id): Promise<void>;
  /** Removes unbound attachments older than `olderThanMs` (default 24 h). Returns how many were removed. */
  cleanupOrphans(opts?: { olderThanMs?: number }): Promise<number>;
}

// ── S2 ──────────────────────────────────────────────────────────────────────────────────────────

export interface ModelCatalog {
  /** 1 h TTL (memory + `cache/models.json`); stale cache on failure; throws `ProviderError` if nothing cached. */
  list(opts?: { refresh?: boolean; signal?: AbortSignal }): Promise<ModelInfo[]>;
  /** Forget the failure backoff (the API key changed, so a past `no_api_key` / auth error no longer applies). */
  resetFailure(): void;
  /** Never throws. Unknown id (or no catalog) → `{ id, name: id, supportsTools: true, supportsImages: false, … }`. */
  get(id: string): Promise<ModelInfo>;
}

// ── S4 ──────────────────────────────────────────────────────────────────────────────────────────

export interface RunTurnInput {
  chatId: Id;
  /** Absent = retry (truncate after the last user message, then rerun). */
  newUserMessage?: { text: string; attachmentIds: Id[] };
  model: string;
  signal: AbortSignal;
  /** Awaited by the agent (back-pressure for SSE writes). Must not throw. */
  emit: (event: AgentEvent) => void | Promise<void>;
}

export interface AgentService {
  /**
   * Never throws; every failure becomes events, always ending with `done`. Registers the run
   * synchronously (before its first `await`), so `isRunning` is true as soon as it is called.
   * If a run is already active for the chat it emits `error` (`conflict`) + `done`.
   */
  runTurn(input: RunTurnInput): Promise<void>;
  isRunning(chatId: Id): boolean;
  abort(chatId: Id): void;
}

export interface Core {
  settings: SettingsService; // S1
  projects: ProjectsService; // S1
  chats: ChatsService; // S1
  attachments: AttachmentsService; // S1
  models: ModelCatalog; // S2
  agent: AgentService; // S4
  provider: Provider; // S5 (needed by PUT /settings/openrouter-key → validateKey)
}

export type CreateCore = (deps: CoreDeps) => Promise<Core>;
