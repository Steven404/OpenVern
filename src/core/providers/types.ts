// Provider interface (plan §4.6). One adapter per provider; messages are normalised.

import type { ErrorCode } from '@shared/errors';
import type { ModelInfo, ToolCall, Usage } from '@shared/types';

export interface Provider {
  readonly id: string; // 'openrouter' | 'fake'
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  validateKey(apiKey: string, signal?: AbortSignal): Promise<void>; // throws ProviderError
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>; // throws ProviderError
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools?: ToolSpec[]; // omitted or empty = no tools
  maxTokens?: number;
}

export type ProviderMessage =
  | { role: 'user'; content: ContentPart[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; providerMeta?: unknown }
  | { role: 'tool'; toolCallId: string; content: string };

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mime: string; base64: string };

export type ProviderEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; call: ToolCall } // emitted once the call's arguments are complete
  | { type: 'meta'; providerMeta: unknown } // opaque data to store on the assistant message
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'other' };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export class ProviderError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = false,
    public status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Providers get the key through this; `null` → `ProviderError('no_api_key')`. */
export type GetApiKey = () => Promise<string | null>;
