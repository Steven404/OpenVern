// The renderer's only way to talk to the backend (plan §4.9).

import type { ApplyChangesBody, ApplyChangesResponse, HealthResponse, UndoBatchResponse } from '@shared/api';
import type { ApiErrorInfo } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import type { TerminalBridge, TerminalReadAnswer } from '@shared/terminal';
import type {
  AttachmentRef,
  Chat,
  ChatChanges,
  ChatSummary,
  EditMode,
  HomeFileListing,
  Id,
  ModelInfo,
  Project,
  ProjectFileContent,
  ProjectFileListing,
  ProjectFileSearchResult,
  ProjectListItem,
  PublicSettings,
  ReasoningEffort,
} from '@shared/types';

export interface ApiClient {
  health(): Promise<HealthResponse>;
  getSettings(): Promise<PublicSettings>;
  setOpenRouterKey(apiKey: string): Promise<PublicSettings>;
  removeOpenRouterKey(): Promise<PublicSettings>;
  updateSettings(patch: { lastModel?: string; lastEffort?: ReasoningEffort | null }): Promise<PublicSettings>;
  listModels(opts?: { refresh?: boolean }): Promise<ModelInfo[]>;
  listProjects(): Promise<ProjectListItem[]>;
  createProject(input: { rootPath: string; name?: string }): Promise<Project>;
  renameProject(id: Id, name: string): Promise<Project>;
  deleteProject(id: Id): Promise<void>;
  listChats(): Promise<ChatSummary[]>;
  /** `editMode` omitted = 'review'. */
  createChat(input: { projectId: Id | null; model: string; editMode?: EditMode }): Promise<Chat>;
  getChat(id: Id): Promise<Chat>;
  /** `editMode` is accepted while a run is active; the agent picks it up from the next turn. */
  updateChat(
    id: Id,
    patch: { title?: string; projectId?: Id | null; archived?: boolean; editMode?: EditMode },
  ): Promise<ChatSummary>;
  deleteChat(id: Id): Promise<void>;
  /** `terminal`: this client answers terminal reads (set when the bridge has a terminal), so `read_terminal` is offered. */
  sendMessage(
    chatId: Id,
    input: { text: string; attachmentIds: Id[]; model: string; effort?: ReasoningEffort | null; terminal?: boolean },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  retry(
    chatId: Id,
    input: { model: string; effort?: ReasoningEffort | null; terminal?: boolean },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  uploadAttachment(file: File): Promise<AttachmentRef>;
  deleteAttachment(id: Id): Promise<void>;
  attachmentUrl(id: Id): string;
  // v0.2 (plan §4.8)
  /** Direct children of one project folder (`dir`, project-relative POSIX; default the root). */
  listProjectFiles(projectId: Id, dir?: string, signal?: AbortSignal): Promise<ProjectFileListing>;
  /** Files whose project-relative path contains `query`, case-insensitive (the Files filter). */
  searchProjectFiles(projectId: Id, query: string, signal?: AbortSignal): Promise<ProjectFileSearchResult>;
  readProjectFile(projectId: Id, path: string): Promise<ProjectFileContent>;
  attachProjectFile(projectId: Id, path: string): Promise<AttachmentRef>;
  /** Home directory, used when a chat has no project. */
  listHomeFiles(dir?: string, signal?: AbortSignal): Promise<HomeFileListing>;
  searchHomeFiles(query: string, signal?: AbortSignal): Promise<ProjectFileSearchResult>;
  readHomeFile(path: string): Promise<ProjectFileContent>;
  attachHomeFile(path: string): Promise<AttachmentRef>;
  getChatChanges(chatId: Id): Promise<ChatChanges>;
  applyChatChanges(chatId: Id, body: ApplyChangesBody): Promise<ApplyChangesResponse>;
  discardChatChanges(chatId: Id): Promise<ChatChanges>;
  /** The Undo button of an auto batch. Rejects with a 409 while the chat runs or when the batch can't be undone. */
  undoChatBatch(chatId: Id, batchId: Id): Promise<UndoBatchResponse>;
  // Terminal (terminal plan §4.2)
  /** Answers a `terminal_read_request`. Rejects with a 404 `ApiError` when the request is unknown or already answered. */
  answerTerminalRead(chatId: Id, requestId: Id, answer: TerminalReadAnswer): Promise<void>;
}

/** Thrown by every method on a non-2xx response or a network failure. */
export class ApiError extends Error {
  constructor(
    public info: ApiErrorInfo,
    public status?: number,
  ) {
    super(info.message);
    this.name = 'ApiError';
  }
}

/** Platform bridge: set by preload in Electron, `undefined` in the browser. */
export interface OpenVernBridge {
  isElectron: true;
  pickDirectory(): Promise<string | null>;
  /** The PTY in main (terminal plan §4.1). Absent until the preload exposes it. */
  terminal?: TerminalBridge;
}

declare global {
  interface Window {
    openvern?: OpenVernBridge;
  }
}
