// Core composition contracts (plan §4.8). `createCore` itself is implemented in S5 (`./index.ts`).
// Service signatures were locked by the V0 orchestrator before wave 2 so S1/S2/S4/S5 build against the
// same shapes. Errors: services throw `CoreError` (./errors.ts); providers throw `ProviderError`.

import type { ApplyChangesResponse } from '@shared/api';
import type { AgentEvent } from '@shared/events';
import type {
  AttachmentRef,
  Chat,
  ChatChanges,
  ChatSummary,
  HomeFileTree,
  HunkDecision,
  Id,
  IsoDate,
  Message,
  ModelInfo,
  Project,
  ProjectFileContent,
  ProjectFileTree,
  ProjectListItem,
  PublicSettings,
} from '@shared/types';
import type { Provider } from './providers/types';
import type { ToolChanges } from './tools/types';

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
  /** The app version (`pkg.version` in dev, `app.getVersion()` in Electron). */
  version: string;
  /** Files panel root for chats with no project. Defaults to the user's home directory. */
  homeDir?: string;
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
  /**
   * Expands `~`, requires an absolute path, realpaths, checks readable dir outside the data dir (a folder that
   * contains the data dir is fine). Throws `path_invalid` or `conflict` (same realpath).
   */
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
  /**
   * Bumps `updatedAt` only when `model` changes (renames, moves and archive changes don't reorder the sidebar).
   * `archived` applies only to chats without a project: a chat that ends up in a project is always unarchived,
   * and `archived: true` for one throws `conflict` without writing. Moving to `projectId: null` keeps the flag.
   */
  update(
    id: Id,
    patch: { title?: string; projectId?: Id | null; model?: string; archived?: boolean },
  ): Promise<ChatSummary>;
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
  changes: ChangesService; // v0.2 G1
  projectFiles: ProjectFilesService; // v0.2 G3
  version: string;
}

// ── v0.2 (plan §4.7) ─────────────────────────────────────────────────────────────────────────────

export interface ChangesService {
  get(chatId: Id): Promise<ChatChanges>;
  /** One per assistant step: stages are attributed to `messageId`. */
  tools(input: { chatId: Id; projectRoot: string; messageId: Id }): ToolChanges;
  /** At a new user message: remember the pending set so a retry of this turn can restore it. */
  snapshot(chatId: Id, userMessageId: Id): Promise<void>;
  /** Retry: restore the snapshot taken for this user message. Never touches disk. */
  restore(chatId: Id, userMessageId: Id): Promise<void>;
  /** The text for the next user message's `changesNote`; marks those events as reported. */
  takeNote(chatId: Id): Promise<string | undefined>;
  apply(input: {
    chatId: Id;
    projectRoot: string;
    revision: number;
    decisions: Record<string, Record<string, HunkDecision>>;
  }): Promise<ApplyChangesResponse>;
  discard(chatId: Id): Promise<ChatChanges>;
  removeForChat(chatId: Id): Promise<void>;
}

export interface ProjectFilesService {
  tree(projectId: Id, signal?: AbortSignal): Promise<ProjectFileTree>;
  read(projectId: Id, relPath: string): Promise<ProjectFileContent>;
  /** Raw bytes for "Attach" (images aren't text). Same sandbox as `read`; throws `file_too_large` over the image limit. */
  readBytes(projectId: Id, relPath: string): Promise<{ name: string; bytes: Uint8Array }>;
  /** Home directory listing for a chat that has no project. Same walker, ignore rules and deny list as `tree`. */
  homeTree(signal?: AbortSignal): Promise<HomeFileTree>;
  homeRead(relPath: string): Promise<ProjectFileContent>;
  homeReadBytes(relPath: string): Promise<{ name: string; bytes: Uint8Array }>;
}

export type CreateCore = (deps: CoreDeps) => Promise<Core>;
