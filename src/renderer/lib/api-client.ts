// The renderer's only way to talk to the backend (plan §4.9).

import type { ApplyChangesBody, ApplyChangesResponse, HealthResponse } from '@shared/api';
import type { ApiErrorInfo } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import type {
  AttachmentRef,
  Chat,
  ChatChanges,
  ChatSummary,
  HomeFileTree,
  Id,
  ModelInfo,
  Project,
  ProjectFileContent,
  ProjectFileTree,
  ProjectListItem,
  PublicSettings,
} from '@shared/types';

export interface ApiClient {
  health(): Promise<HealthResponse>;
  getSettings(): Promise<PublicSettings>;
  setOpenRouterKey(apiKey: string): Promise<PublicSettings>;
  removeOpenRouterKey(): Promise<PublicSettings>;
  updateSettings(patch: { lastModel?: string }): Promise<PublicSettings>;
  listModels(opts?: { refresh?: boolean }): Promise<ModelInfo[]>;
  listProjects(): Promise<ProjectListItem[]>;
  createProject(input: { rootPath: string; name?: string }): Promise<Project>;
  renameProject(id: Id, name: string): Promise<Project>;
  deleteProject(id: Id): Promise<void>;
  listChats(): Promise<ChatSummary[]>;
  createChat(input: { projectId: Id | null; model: string }): Promise<Chat>;
  getChat(id: Id): Promise<Chat>;
  updateChat(id: Id, patch: { title?: string; projectId?: Id | null; archived?: boolean }): Promise<ChatSummary>;
  deleteChat(id: Id): Promise<void>;
  sendMessage(
    chatId: Id,
    input: { text: string; attachmentIds: Id[]; model: string },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  retry(chatId: Id, input: { model: string }, signal: AbortSignal): AsyncIterable<AgentEvent>;
  uploadAttachment(file: File): Promise<AttachmentRef>;
  deleteAttachment(id: Id): Promise<void>;
  attachmentUrl(id: Id): string;
  // v0.2 (plan §4.8)
  listProjectFiles(projectId: Id): Promise<ProjectFileTree>;
  readProjectFile(projectId: Id, path: string): Promise<ProjectFileContent>;
  attachProjectFile(projectId: Id, path: string): Promise<AttachmentRef>;
  /** Home directory, used when a chat has no project. */
  listHomeFiles(): Promise<HomeFileTree>;
  readHomeFile(path: string): Promise<ProjectFileContent>;
  attachHomeFile(path: string): Promise<AttachmentRef>;
  getChatChanges(chatId: Id): Promise<ChatChanges>;
  applyChatChanges(chatId: Id, body: ApplyChangesBody): Promise<ApplyChangesResponse>;
  discardChatChanges(chatId: Id): Promise<ChatChanges>;
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
}

declare global {
  interface Window {
    openvern?: OpenVernBridge;
  }
}
