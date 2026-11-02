// Chat.messages → ProviderMessage[] (S4.7).

import type { AttachmentRef, Message, ToolCall, ToolMessage } from '@shared/types';
import type { ContentPart, ProviderMessage } from '../providers/types';
import { redactSecrets } from '../security/redact';
import { withChangesNote } from './edit-mode';

export interface HistoryOptions {
  /** The model the next request is for. */
  model: string;
  /** Images are only sent when the model accepts them. */
  supportsImages: boolean;
  /** True when this request includes tool definitions. When false, tool calls/results are flattened into text. */
  toolsOffered: boolean;
  readAttachment(id: string): Promise<Uint8Array>;
  /** Exact secret values to redact from replayed tool output (plan K1). */
  knownSecrets?: readonly string[];
}

export const INTERRUPTED_OUTPUT = 'Interrupted: the run was stopped before this tool finished.';

/** Local caps for replaying past tool activity as text to a model that can't act on it. */
export const FLATTENED_TOOL_OUTPUT_CHARS = 2000;
export const FLATTENED_TOOL_ARGS_CHARS = 300;

/** One past tool call and its result as plain text (used when no tools are offered). */
export function flattenToolCall(call: ToolCall, result: ToolMessage | undefined): string {
  let args = call.argsJson.trim() || '{}';
  if (args.length > FLATTENED_TOOL_ARGS_CHARS) args = `${args.slice(0, FLATTENED_TOOL_ARGS_CHARS)}…`;
  const ok = result ? result.ok : false;
  const output = result ? result.output : INTERRUPTED_OUTPUT;
  let text = `[tool ${call.name} ${args} → ${ok ? 'ok' : 'error'}]`;
  if (output.length > 0) {
    const shown =
      output.length > FLATTENED_TOOL_OUTPUT_CHARS
        ? `${output.slice(0, FLATTENED_TOOL_OUTPUT_CHARS)}\n[… ${output.length - FLATTENED_TOOL_OUTPUT_CHARS} more characters truncated]`
        : output;
    text += `\n${shown}`;
  }
  return text;
}

export function omittedImageText(name: string): string {
  return `[Image "${name}" omitted: the current model does not accept images]`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

async function attachmentParts(att: AttachmentRef, opts: HistoryOptions): Promise<ContentPart[]> {
  if (att.kind === 'image' && !opts.supportsImages) return [{ type: 'text', text: omittedImageText(att.name) }];
  let bytes: Uint8Array;
  try {
    bytes = await opts.readAttachment(att.id);
  } catch {
    return [{ type: 'text', text: `[Attachment "${att.name}" is no longer available]` }];
  }
  if (att.kind === 'image') {
    return [{ type: 'image', mime: att.mime, base64: Buffer.from(bytes).toString('base64') }];
  }
  const content = new TextDecoder('utf-8').decode(bytes);
  return [{ type: 'text', text: `<attached_file name="${escapeAttr(att.name)}">\n${content}\n</attached_file>` }];
}

/**
 * Rules:
 * - A user message becomes: attachment parts (in order), then its text.
 * - Assistant messages are included whatever their status; one with no text and no tool calls is skipped
 *   (an empty assistant turn is invalid for most providers).
 * - Every tool call is followed by its result. A call with no persisted result gets a synthetic `ok:false`
 *   "Interrupted" result, so the history stays valid. Tool messages are emitted next to their assistant message;
 *   orphans are dropped.
 * - `providerMeta` is only replayed for messages produced by the same model it will be sent to.
 * - When no tools are offered (`toolsOffered: false`) there are no `toolCalls` and no `tool` messages: each call and
 *   its result is flattened into the assistant text, `providerMeta` is dropped from such messages, and consecutive
 *   assistant messages are merged so roles keep alternating.
 */
export async function buildHistory(messages: Message[], opts: HistoryOptions): Promise<ProviderMessage[]> {
  const results = new Map<string, ToolMessage>();
  // Tool output is redacted when it is stored; chats saved before that (plan K1) are scrubbed here on the way out.
  for (const m of messages) {
    if (m.role === 'tool') {
      results.set(m.toolCallId, { ...m, output: redactSecrets(m.output, { known: opts.knownSecrets }).text });
    }
  }

  const out: ProviderMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content: ContentPart[] = [];
      for (const att of m.attachments) content.push(...(await attachmentParts(att, opts)));
      // The note about earlier proposals reaches the provider only; it is never shown in the UI (plan §4.9).
      const text = withChangesNote(m.text, m.changesNote);
      if (text.length > 0 || content.length === 0) content.push({ type: 'text', text });
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      if (m.text.length === 0 && m.toolCalls.length === 0) continue;
      if (!opts.toolsOffered) {
        const text = [m.text, ...m.toolCalls.map((c) => flattenToolCall(c, results.get(c.id)))]
          .filter((t) => t.length > 0)
          .join('\n\n');
        const prev = out.at(-1);
        if (prev?.role === 'assistant') {
          prev.text = `${prev.text}\n\n${text}`;
          delete prev.providerMeta;
        } else {
          out.push({
            role: 'assistant',
            text,
            toolCalls: [],
            ...(m.toolCalls.length === 0 && m.providerMeta !== undefined && m.model === opts.model
              ? { providerMeta: m.providerMeta }
              : {}),
          });
        }
        continue;
      }
      out.push({
        role: 'assistant',
        text: m.text,
        toolCalls: m.toolCalls,
        ...(m.providerMeta !== undefined && m.model === opts.model ? { providerMeta: m.providerMeta } : {}),
      });
      for (const call of m.toolCalls) {
        out.push({
          role: 'tool',
          toolCallId: call.id,
          content: results.get(call.id)?.output ?? INTERRUPTED_OUTPUT,
        });
      }
    }
  }
  return out;
}
