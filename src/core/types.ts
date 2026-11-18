// Core composition contracts (plan §4.8). `createCore` itself is implemented in S5 (`./index.ts`).
// Service signatures were locked by the V0 orchestrator before wave 2 so S1/S2/S4/S5 build against the
// same shapes. Errors: services throw `CoreError` (./errors.ts); providers throw `ProviderError`.

import type { ApplyChangesResponse, UndoBatchResponse } from '@shared/api';
import type { AgentEvent } from '@shared/events';
import type { TerminalReadAnswer, TerminalReadRequest } from '@shared/terminal';
import type {
  AttachmentRef,
  BatchUndo,
  Chat,
  ChatChanges,
  ChatSummary,
  EditMode,
  HomeFileListing,
  HunkDecision,
  Id,
  IsoDate,
  Message,
  ModelInfo,
  Project,
  ProjectFileContent,
  ProjectFileListing,
  ProjectFileSearchResult,
  ProjectListItem,
  PublicSettings,
  ReasoningEffort,
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
  update(patch: { lastModel?: string; lastEffort?: ReasoningEffort | null }): Promise<PublicSettings>;
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

/** What `ChatsService.update` checks under the lock that commits (see there). */
export interface ChatUpdateExpect {
  editMode?: EditMode;
  projectId?: Id | null;
  checkAutoProject?: (projectId: Id) => Promise<void>;
}

export interface ChatsService {
  /** Sorted by `updatedAt` desc. */
  list(): Promise<ChatSummary[]>;
  /** Throws `CoreError('not_found')`. */
  get(id: Id): Promise<Chat>;
  /** Title `NEW_CHAT_TITLE`, no messages, `editMode` default 'review'. Throws `not_found` if `projectId` is unknown. */
  create(input: { projectId: Id | null; model: string; editMode?: EditMode }): Promise<Chat>;
  /**
   * Bumps `updatedAt` only when `model` or `effort` changes (renames, moves, archive and edit-mode changes don't
   * reorder the sidebar). `archived` applies to any chat, in a project or not. Only `archived` changes the flag: moving a chat
   * between projects, or to and from `projectId: null`, keeps it.
   *
   * `expect`: what the client showed when the user acted. Each field that is set is compared with the stored chat
   * under the lock that commits the write; a mismatch throws `conflict` (`EDIT_MODE_CHANGED` /
   * `CHAT_PROJECT_CHANGED`) and writes nothing. `checkAutoProject` runs under the same lock, after those checks and
   * before the write, when the update turns Auto on in a project or moves an Auto chat into another project, with the
   * project the chat will run in; throwing refuses the update and writes nothing.
   */
  update(
    id: Id,
    patch: {
      title?: string;
      projectId?: Id | null;
      model?: string;
      archived?: boolean;
      effort?: ReasoningEffort | null;
      editMode?: EditMode;
    },
    expect?: ChatUpdateExpect,
  ): Promise<ChatSummary>;
  /**
   * Replaces one user message's `changesNote` (`undefined` removes it); a retry adds what it couldn't undo. Doesn't
   * bump `updatedAt`. Throws `not_found` when the chat has no user message with that id.
   */
  setChangesNote(chatId: Id, messageId: Id, note: string | undefined): Promise<void>;
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
  /** F3: omitted = the chat's stored effort. `null` = Default (no `reasoning` field sent). */
  effort?: ReasoningEffort | null;
  signal: AbortSignal;
  /** Awaited by the agent (back-pressure for SSE writes). Must not throw. */
  emit: (event: AgentEvent) => void | Promise<void>;
  /** The client can answer terminal reads (Electron), so `read_terminal` is offered (terminal plan §2). */
  terminal?: boolean;
  /**
   * The edit mode this turn runs in. The HTTP routes read it under the turn's start claim and check it against the
   * mode the client showed, so the turn uses the very value that was checked: a PATCH landing after that read
   * applies from the next turn. Omitted = the agent reads the chat's stored mode once at turn start.
   */
  editMode?: EditMode;
  /**
   * The project this turn runs in, read under the start claim together with `editMode`, so a move landing after
   * that read can't run the checked mode in another project. Omitted = the chat's stored project, read once at
   * turn start.
   */
  projectId?: Id | null;
}

/** Relays `read_terminal` to the client: a stream event out, an HTTP answer back (terminal plan §3, §4.3). */
export interface TerminalReadBroker {
  /** Emits `terminal_read_request` and waits. Timeout and abort resolve to `{ ok: false, reason: 'unavailable' }`. */
  request(
    chatId: Id,
    request: TerminalReadRequest,
    opts: { emit: RunTurnInput['emit']; signal: AbortSignal },
  ): Promise<TerminalReadAnswer>;
  /** False when nothing is waiting under that id. One answer per request. */
  answer(chatId: Id, requestId: Id, answer: TerminalReadAnswer): boolean;
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
  terminalReads: TerminalReadBroker; // terminal plan T2
  version: string;
}

// ── v0.2 (plan §4.7) ─────────────────────────────────────────────────────────────────────────────

export interface ChangesService {
  get(chatId: Id): Promise<ChatChanges>;
  /**
   * One per assistant step: stages and writes are attributed to `messageId`. `turnId` = the user message that started
   * the turn; `mode` = the turn's edit mode (picks `stage` or `write`).
   */
  tools(input: {
    chatId: Id;
    projectId: Id;
    projectRoot: string;
    messageId: Id;
    turnId: Id;
    mode: EditMode;
  }): ToolChanges;
  /** At a new user message: remember the pending set so a retry of this turn can restore it. */
  snapshot(chatId: Id, userMessageId: Id): Promise<void>;
  /** Retry: restore the snapshot taken for this user message. Never touches disk. */
  restore(chatId: Id, userMessageId: Id): Promise<void>;
  /**
   * The note for a new user message; marks what it reports as reported. Adds a mode line when `mode` differs from the
   * last noted turn's mode (a store without one counts as 'review'), except on the chat's first turn. Records `mode`
   * as the last noted mode.
   */
  takeNote(chatId: Id, opts: { mode: EditMode; firstTurn: boolean }): Promise<string | undefined>;
  apply(input: {
    chatId: Id;
    projectRoot: string;
    revision: number;
    decisions: Record<string, Record<string, HunkDecision>>;
  }): Promise<ApplyChangesResponse>;
  discard(chatId: Id): Promise<ChatChanges>;
  /**
   * The Undo button: restores the batch's files that are still exactly as the turn left them and reports the rest.
   * Throws `not_found` (unknown batch) or `conflict` (a review batch, already undone, past retention, or written into
   * another project).
   */
  undoBatch(input: { chatId: Id; projectId: Id; projectRoot: string; batchId: Id }): Promise<UndoBatchResponse>;
  /**
   * Before a retry: undo every auto batch of `turnId` that isn't undone yet, forget what the chat has seen, and record
   * `mode` as the last noted mode. Adds nothing to the next note. Null when there was nothing to undo.
   */
  prepareRetry(input: {
    chatId: Id;
    projectId: Id;
    projectRoot: string;
    turnId: Id;
    mode: EditMode;
  }): Promise<{ batchId: Id; undo: BatchUndo } | null>;
  /** Deletes the store and the chat's blob folder, under the store lock. */
  removeForChat(chatId: Id): Promise<void>;
}

export interface ProjectFilesService {
  /** Direct children of the project folder `dir` (`''` = root). Refuses folders the full walk would never show. */
  list(projectId: Id, dir: string, signal?: AbortSignal): Promise<ProjectFileListing>;
  /** Files whose project-relative path contains `query` (case-insensitive). Same walker and rules as `list`. */
  search(projectId: Id, query: string, signal?: AbortSignal): Promise<ProjectFileSearchResult>;
  read(projectId: Id, relPath: string): Promise<ProjectFileContent>;
  /** Raw bytes for "Attach" (images aren't text). Same sandbox as `read`; throws `file_too_large` over the image limit. */
  readBytes(projectId: Id, relPath: string): Promise<{ name: string; bytes: Uint8Array }>;
  /** Home directory listing for a chat that has no project. Same walker and rules as `list`, plus the home deny layer. */
  homeList(dir: string, signal?: AbortSignal): Promise<HomeFileListing>;
  homeSearch(query: string, signal?: AbortSignal): Promise<ProjectFileSearchResult>;
  homeRead(relPath: string): Promise<ProjectFileContent>;
  homeReadBytes(relPath: string): Promise<{ name: string; bytes: Uint8Array }>;
}

export type CreateCore = (deps: CoreDeps) => Promise<Core>;
