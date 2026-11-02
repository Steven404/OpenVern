// Domain types shared by core, server and renderer (plan §4.1).

import type { ApiErrorInfo } from './errors';

export type Id = string; // crypto.randomUUID()
export type IsoDate = string; // new Date().toISOString()

export interface Project {
  id: Id;
  name: string;
  rootPath: string; // absolute, realpath'd
  createdAt: IsoDate;
}
export interface ProjectListItem extends Project {
  chatCount: number;
}

export interface ChatSummary {
  id: Id;
  projectId: Id | null; // null = loose chat ("Chats" section), no tools
  title: string; // "New chat" until auto-titled
  model: string; // model used for the latest turn
  createdAt: IsoDate;
  updatedAt: IsoDate;
}
export interface Chat extends ChatSummary {
  messages: Message[];
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface UserMessage {
  id: Id;
  role: 'user';
  createdAt: IsoDate;
  text: string;
  attachments: AttachmentRef[];
}

export interface AssistantMessage {
  id: Id;
  role: 'assistant';
  createdAt: IsoDate;
  model: string;
  text: string; // markdown
  toolCalls: ToolCall[]; // in the order the model requested them
  status: 'complete' | 'stopped' | 'error';
  error?: ApiErrorInfo;
  usage?: Usage;
  providerMeta?: unknown; // opaque; the provider adapter round-trips it (e.g. OpenRouter reasoning_details)
  /** UI-only note shown under the message; never sent to the provider. */
  notice?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  argsJson: string; // raw JSON string from the model
}

export interface ToolMessage {
  id: Id;
  role: 'tool';
  createdAt: IsoDate;
  toolCallId: string;
  name: string;
  ok: boolean;
  output: string; // exactly what was sent back to the model (already truncated)
  summary: string; // short UI label, e.g. "src/agent/loop.ts" or "\"useEffect\" in src/"
  durationMs: number;
}

export interface AttachmentRef {
  id: Id;
  name: string;
  mime: string;
  size: number;
  kind: 'text' | 'image';
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
}

export interface ModelInfo {
  id: string; // "anthropic/claude-…"
  name: string; // OpenRouter display name, e.g. "Anthropic: Claude …"
  contextLength: number | null;
  supportsTools: boolean; // supported_parameters includes "tools"
  supportsImages: boolean; // architecture.input_modalities includes "image"
  promptPricePerMTok: number | null;
  completionPricePerMTok: number | null;
}

export interface PublicSettings {
  openRouter: { configured: boolean; keyHint: string | null };
  lastModel: string | null;
}
