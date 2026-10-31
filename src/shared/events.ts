// Stream events sent by the streaming routes (plan §4.4).
// Wire format: one SSE frame per event, `data: <JSON AgentEvent>\n\n` (no `event:` field).

import type { ApiErrorInfo } from './errors';
import type { AssistantMessage, ChatSummary, Id, ToolCall, ToolMessage, UserMessage } from './types';

export type AgentEvent =
  | { type: 'user_message'; message: UserMessage } // persisted user message (first event of /messages)
  | { type: 'assistant_start'; messageId: Id; model: string }
  | { type: 'text_delta'; messageId: Id; delta: string }
  | { type: 'tool_call'; messageId: Id; toolCall: ToolCall } // tool is now running
  | { type: 'tool_result'; message: ToolMessage }
  | { type: 'assistant_end'; message: AssistantMessage } // final persisted form of that assistant message
  | { type: 'chat_updated'; chat: ChatSummary } // title, model or updatedAt changed
  | { type: 'error'; error: ApiErrorInfo } // run-level error; the run then ends
  | { type: 'done' }; // always the last event

export type AgentEventType = AgentEvent['type'];

/** Serialises one event as an SSE frame. */
export function encodeAgentEvent(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
