// Chat.messages → ProviderMessage[] (S4.7).

import type { AttachmentRef, Message, ToolMessage } from '@shared/types';
import type { ContentPart, ProviderMessage } from '../providers/types';

export interface HistoryOptions {
  /** The model the next request is for. */
  model: string;
  /** Images are only sent when the model accepts them. */
  supportsImages: boolean;
  readAttachment(id: string): Promise<Uint8Array>;
}

export const INTERRUPTED_OUTPUT = 'Interrupted: the run was stopped before this tool finished.';

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
 */
export async function buildHistory(messages: Message[], opts: HistoryOptions): Promise<ProviderMessage[]> {
  const results = new Map<string, ToolMessage>();
  for (const m of messages) if (m.role === 'tool') results.set(m.toolCallId, m);

  const out: ProviderMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content: ContentPart[] = [];
      for (const att of m.attachments) content.push(...(await attachmentParts(att, opts)));
      if (m.text.length > 0 || content.length === 0) content.push({ type: 'text', text: m.text });
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      if (m.text.length === 0 && m.toolCalls.length === 0) continue;
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
