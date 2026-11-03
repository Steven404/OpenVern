import { API_PREFIX, type ApplyChangesBody, type ApplyChangesResponse, type HealthResponse } from '@shared/api';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@shared/constants';
import { errorInfo, isApiErrorBody } from '@shared/errors';
import type { AgentEvent } from '@shared/events';
import { readSSE } from '@shared/sse';
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
import { type ApiClient, ApiError } from './api-client';

const SERVER_UNREACHABLE = "Couldn't reach the OpenVern server.";

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** `ApiClient` over `fetch` + SSE. Talks to `/api` on the current origin (Vite proxy in dev, `app://` in prod). */
export class HttpApiClient implements ApiClient {
  constructor(
    private readonly baseUrl = API_PREFIX,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  private async send(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(CLIENT_HEADER, CLIENT_HEADER_VALUE);
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, { ...init, method, headers, body: payload });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new ApiError(errorInfo('network_error', SERVER_UNREACHABLE));
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    return (await res.json()) as T;
  }

  private async noContent(method: string, path: string): Promise<void> {
    await this.send(method, path);
  }

  private async *stream(path: string, body: unknown, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const res = await this.send('POST', path, body, { signal, headers: { Accept: 'text/event-stream' } });
    if (!res.body) throw new ApiError(errorInfo('internal', 'The server sent an empty stream.'), res.status);
    try {
      for await (const data of readSSE(res.body)) yield JSON.parse(data) as AgentEvent;
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw err;
      throw new ApiError(errorInfo('network_error', SERVER_UNREACHABLE));
    }
  }

  health() {
    return this.json<HealthResponse>('GET', '/health');
  }
  getSettings() {
    return this.json<PublicSettings>('GET', '/settings');
  }
  setOpenRouterKey(apiKey: string) {
    return this.json<PublicSettings>('PUT', '/settings/openrouter-key', { apiKey });
  }
  removeOpenRouterKey() {
    return this.json<PublicSettings>('DELETE', '/settings/openrouter-key');
  }
  updateSettings(patch: { lastModel?: string }) {
    return this.json<PublicSettings>('PATCH', '/settings', patch);
  }
  listModels(opts?: { refresh?: boolean }) {
    return this.json<ModelInfo[]>('GET', `/models${opts?.refresh ? '?refresh=1' : ''}`);
  }
  listProjects() {
    return this.json<ProjectListItem[]>('GET', '/projects');
  }
  createProject(input: { rootPath: string; name?: string }) {
    return this.json<Project>('POST', '/projects', input);
  }
  renameProject(id: Id, name: string) {
    return this.json<Project>('PATCH', `/projects/${enc(id)}`, { name });
  }
  deleteProject(id: Id) {
    return this.noContent('DELETE', `/projects/${enc(id)}`);
  }
  listChats() {
    return this.json<ChatSummary[]>('GET', '/chats');
  }
  createChat(input: { projectId: Id | null; model: string }) {
    return this.json<Chat>('POST', '/chats', input);
  }
  getChat(id: Id) {
    return this.json<Chat>('GET', `/chats/${enc(id)}`);
  }
  updateChat(id: Id, patch: { title?: string; projectId?: Id | null }) {
    return this.json<ChatSummary>('PATCH', `/chats/${enc(id)}`, patch);
  }
  deleteChat(id: Id) {
    return this.noContent('DELETE', `/chats/${enc(id)}`);
  }
  sendMessage(chatId: Id, input: { text: string; attachmentIds: Id[]; model: string }, signal: AbortSignal) {
    return this.stream(`/chats/${enc(chatId)}/messages`, input, signal);
  }
  retry(chatId: Id, input: { model: string }, signal: AbortSignal) {
    return this.stream(`/chats/${enc(chatId)}/retry`, input, signal);
  }
  uploadAttachment(file: File) {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.json<AttachmentRef>('POST', '/attachments', form);
  }
  deleteAttachment(id: Id) {
    return this.noContent('DELETE', `/attachments/${enc(id)}`);
  }
  attachmentUrl(id: Id) {
    return `${this.baseUrl}/attachments/${enc(id)}/content`;
  }

  listProjectFiles(projectId: Id) {
    return this.json<ProjectFileTree>('GET', `/projects/${enc(projectId)}/files`);
  }
  readProjectFile(projectId: Id, path: string) {
    return this.json<ProjectFileContent>('GET', `/projects/${enc(projectId)}/files/content?path=${enc(path)}`);
  }
  attachProjectFile(projectId: Id, path: string) {
    return this.json<AttachmentRef>('POST', `/projects/${enc(projectId)}/files/attach`, { path });
  }
  listHomeFiles() {
    return this.json<HomeFileTree>('GET', '/home/files');
  }
  readHomeFile(path: string) {
    return this.json<ProjectFileContent>('GET', `/home/files/content?path=${enc(path)}`);
  }
  attachHomeFile(path: string) {
    return this.json<AttachmentRef>('POST', '/home/files/attach', { path });
  }
  getChatChanges(chatId: Id) {
    return this.json<ChatChanges>('GET', `/chats/${enc(chatId)}/changes`);
  }
  applyChatChanges(chatId: Id, body: ApplyChangesBody) {
    return this.json<ApplyChangesResponse>('POST', `/chats/${enc(chatId)}/changes/apply`, body);
  }
  discardChatChanges(chatId: Id) {
    return this.json<ChatChanges>('DELETE', `/chats/${enc(chatId)}/changes`);
  }
}

const enc = encodeURIComponent;

async function toApiError(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  if (isApiErrorBody(body)) return new ApiError(body.error, res.status);
  return new ApiError(
    errorInfo(res.status >= 500 ? 'internal' : 'invalid_request', `Request failed (${res.status}).`),
    res.status,
  );
}
