// Stream events sent by the streaming routes (plan §4.4).
// Wire format: one SSE frame per event, `data: <JSON AgentEvent>\n\n` (no `event:` field).

import type { ApiErrorInfo } from './errors';
import type { TerminalReadRequest } from './terminal';
import type { AssistantMessage, ChangeSummary, ChatSummary, Id, ToolCall, ToolMessage, UserMessage } from './types';

export type AgentEvent =
  | { type: 'user_message'; message: UserMessage } // persisted user message (first event of /messages)
  | { type: 'assistant_start'; messageId: Id; model: string }
  | { type: 'text_delta'; messageId: Id; delta: string }
  | { type: 'tool_call'; messageId: Id; toolCall: ToolCall } // tool is now running
  | { type: 'tool_result'; message: ToolMessage }
  | { type: 'changes_updated'; messageId: Id; changes: ChangeSummary | null } // after a tool_result that staged edits; null: nothing pending any more
  // An Auto write landed in this turn's batch, or a retry undid the turn's earlier writes. Refetch the chat's changes.
  | { type: 'auto_batch_updated'; batchId: Id }
  | { type: 'assistant_end'; message: AssistantMessage } // final persisted form of that assistant message
  | { type: 'chat_updated'; chat: ChatSummary } // title, model or updatedAt changed
  | { type: 'error'; error: ApiErrorInfo } // run-level error; the run then ends
  // The `read_terminal` tool asks the client for the chat's terminal text; the client answers with
  // POST /chats/:id/terminal-reads/:requestId. Sent only when the request said `terminal: true`.
  | { type: 'terminal_read_request'; requestId: Id; request: TerminalReadRequest }
  | { type: 'done' }; // always the last event

export type AgentEventType = AgentEvent['type'];

/** Serialises one event as an SSE frame. */
export function encodeAgentEvent(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
