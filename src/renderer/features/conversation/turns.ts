// Pure helpers that turn a flat message list into turns (S7.3): each user message, then one assistant turn
// containing the assistant texts and tool rows in order.

import type { ApiErrorInfo } from '@shared/errors';
import type { AssistantMessage, Message, ToolCall, ToolMessage, UserMessage } from '@shared/types';
import type { RunState } from '../../stores/runs';

export type ToolState = 'queued' | 'running' | 'ok' | 'failed' | 'skipped';

export interface TextBlock {
  kind: 'text';
  key: string;
  messageId: string;
  text: string;
  /** This message is still receiving deltas. */
  streaming: boolean;
  status: AssistantMessage['status'];
  error?: ApiErrorInfo;
}

export interface ToolBlock {
  kind: 'tool';
  key: string;
  /** The assistant message that made the call. */
  messageId: string;
  call: ToolCall;
  result?: ToolMessage;
  /** `queued`: run open, no `tool_call` yet. `skipped`: the run ended (stopped / failed) before the tool produced a result. */
  state: ToolState;
}

export type Block = TextBlock | ToolBlock;

export interface Turn {
  key: string;
  user: UserMessage | null;
  blocks: Block[];
  /** Model of the first assistant message (header tooltip). */
  model: string | null;
  /** UI-only note from the first assistant message that has one. */
  notice?: string;
}

export interface TurnOptions {
  /** A run is open for this chat: unresolved tool calls are running and the last turn may be waiting. */
  active: boolean;
  streamingId: string | null;
  /** Calls the server reported as started (`tool_call` without `tool_result`); other open calls are queued. */
  runningToolIds: readonly string[];
}

/**
 * Persisted messages followed by the run overlay. The persisted list is cut at the first overlay message it
 * already contains (a refetch during the run), so nothing shows twice.
 */
export function mergeMessages(persisted: Message[], run: RunState | undefined): Message[] {
  if (!run || run.messages.length === 0) return persisted;
  const overlayIds = new Set(run.messages.map((m) => m.id));
  const cut = persisted.findIndex((m) => overlayIds.has(m.id));
  return [...(cut >= 0 ? persisted.slice(0, cut) : persisted), ...run.messages];
}

export function buildTurns(messages: Message[], { active, streamingId, runningToolIds }: TurnOptions): Turn[] {
  const results = new Map<string, ToolMessage>();
  for (const m of messages) if (m.role === 'tool') results.set(m.toolCallId, m);

  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const m of messages) {
    if (m.role === 'user') {
      current = { key: m.id, user: m, blocks: [], model: null };
      turns.push(current);
    } else if (m.role === 'assistant') {
      if (!current) {
        current = { key: `turn-${m.id}`, user: null, blocks: [], model: null };
        turns.push(current);
      }
      current.model ??= m.model || null;
      if (m.notice && !current.notice) current.notice = m.notice;
      const streaming = m.id === streamingId;
      if (m.text || streaming || m.status !== 'complete') {
        current.blocks.push({
          kind: 'text',
          key: m.id,
          messageId: m.id,
          text: m.text,
          streaming,
          status: m.status,
          error: m.error,
        });
      }
      for (const call of m.toolCalls) {
        const result = results.get(call.id);
        current.blocks.push({
          kind: 'tool',
          key: `${m.id}:${call.id}`,
          messageId: m.id,
          call,
          result,
          state: result
            ? result.ok
              ? 'ok'
              : 'failed'
            : !active
              ? 'skipped'
              : runningToolIds.includes(call.id)
                ? 'running'
                : 'queued',
        });
      }
    }
  }
  return turns;
}

/** The chat is waiting for the model: a run is open, nothing is streaming text and no tool is running. */
export function isWaiting(turns: Turn[], run: RunState | undefined): boolean {
  if (run?.status !== 'running') return false;
  const last = turns.at(-1);
  const blocks = last?.blocks ?? [];
  if (blocks.some((b) => b.kind === 'tool' && (b.state === 'running' || b.state === 'queued'))) return false;
  const tail = blocks.at(-1);
  return !(tail?.kind === 'text' && tail.streaming && tail.text.length > 0);
}

/** The turn holds a block of this assistant message (where the Proposed edits card belongs). */
export const turnHasMessage = (turn: Turn, messageId: string): boolean =>
  turn.blocks.some((b) => (b.kind === 'text' ? b.messageId : b.messageId) === messageId);
