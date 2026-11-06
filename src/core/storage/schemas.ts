// zod schemas for the files in plan §3.5. Message-level validation is deliberately loose so that a small
// shape drift never makes a whole chat unreadable; the TypeScript types are the real contract.

import { REASONING_EFFORTS } from '@shared/constants';
import type { AssistantMessage, Chat, ChatSummary, ChatUsage, Message, Project, Usage } from '@shared/types';
import { z } from 'zod';
import type { StoredAttachment } from '../types';

/** F3: `null` is Default (no `reasoning` field). */
const reasoningEffortSchema = z.enum(REASONING_EFFORTS).nullable();

export const settingsFileSchema = z.object({
  version: z.literal(1),
  lastModel: z.string().nullable().default(null),
  lastEffort: reasoningEffortSchema.default(null),
});
export type SettingsFile = z.infer<typeof settingsFileSchema>;

export const secretEntrySchema = z.object({ enc: z.enum(['safeStorage', 'plain']), value: z.string() });
export type SecretEntry = z.infer<typeof secretEntrySchema>;
/** Entries are validated one by one by `FileSecretStore`; the envelope only checks the version. */
export const secretsFileSchema = z.looseObject({ version: z.literal(1) });

const projectSchema: z.ZodType<Project> = z.object({
  id: z.string().min(1),
  name: z.string(),
  rootPath: z.string(),
  createdAt: z.string(),
});
export const projectsFileSchema = z.object({ version: z.literal(1), projects: z.array(projectSchema) });
export type ProjectsFile = z.infer<typeof projectsFileSchema>;

// ── F1: context usage (plan §4.1, §4.3) ───────────────────────────────────────────────────────

/**
 * The cumulative counters kept on the chat file. They survive `truncateAfterLastUser` (retry), so a discarded
 * turn still counts towards the chat's total tokens and cost.
 */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  requests: number;
}

const emptyUsage = (): ChatUsage => ({
  contextTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  costUsd: null,
  requests: 0,
});

const usageSchema: z.ZodType<ChatUsage> = z.object({
  contextTokens: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  costUsd: z.number().nullable(),
  requests: z.number(),
});

const usageTotalsSchema: z.ZodType<UsageTotals> = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  costUsd: z.number().nullable(),
  requests: z.number(),
});

/** Adds one assistant message's usage to the counters. `costUsd` stays `null` until a request reports one. */
export function addUsage(totals: UsageTotals, usage: Usage): UsageTotals {
  return {
    promptTokens: totals.promptTokens + usage.promptTokens,
    completionTokens: totals.completionTokens + usage.completionTokens,
    costUsd: usage.costUsd === undefined ? totals.costUsd : (totals.costUsd ?? 0) + usage.costUsd,
    requests: totals.requests + 1,
  };
}

/** Backfill for a chat file written before F1: the totals are the sum of its stored messages. */
export function totalsFromMessages(messages: readonly Message[]): UsageTotals {
  let totals: UsageTotals = { promptTokens: 0, completionTokens: 0, costUsd: null, requests: 0 };
  for (const message of messages) {
    if (message.role === 'assistant' && message.usage) totals = addUsage(totals, message.usage);
  }
  return totals;
}

/** `contextTokens` follows the latest assistant message that has usage; the rest comes from the counters. */
export function usageFromMessages(messages: readonly Message[], totals: UsageTotals): ChatUsage {
  const latest = messages.findLast(
    (message): message is AssistantMessage => message.role === 'assistant' && message.usage !== undefined,
  );
  return {
    contextTokens: latest?.usage ? latest.usage.promptTokens + latest.usage.completionTokens : 0,
    ...totals,
  };
}

/** The chat as stored: `Chat` plus the cumulative counters kept alongside it. */
export type StoredChat = Chat & { usageTotals: UsageTotals };
/** A chat being built: `usage` and `usageTotals` may be absent and are then derived from the messages. */
export type ChatRecord = Omit<Chat, 'usage'> & { usageTotals?: UsageTotals };

/** Fills in `usage` (always recomputed) and `usageTotals` (backfilled from the messages when missing). */
export function withUsage(chat: ChatRecord): StoredChat {
  const usageTotals = chat.usageTotals ?? totalsFromMessages(chat.messages);
  return { ...chat, usage: usageFromMessages(chat.messages, usageTotals), usageTotals };
}

const chatSummaryShape = {
  id: z.string().min(1),
  projectId: z.string().nullable(),
  title: z.string(),
  model: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // `.catch`, not `.default`: a missing or malformed flag loads as false instead of quarantining the file.
  archived: z.boolean().catch(false),
  // Same idea: an index entry or chat file written before F1 loads as "no usage" instead of being quarantined.
  usage: usageSchema.catch(() => emptyUsage()),
  // F3: `.catch(null)` keeps a malformed effort from quarantining the whole chat; missing = Default.
  effort: reasoningEffortSchema.catch(null),
};
const chatSummarySchema: z.ZodType<ChatSummary> = z.object(chatSummaryShape);
export const chatIndexSchema = z.object({
  version: z.literal(1),
  chats: z.array(chatSummarySchema),
  // F1: written with the summaries since they carry `usage`. An index without it is rebuilt from the chat
  // files, which backfills each chat's totals (see `createChatsService`). Extra field: older readers ignore it.
  usageBackfilled: z.literal(true).optional(),
});
export type ChatIndexFile = z.infer<typeof chatIndexSchema>;

const messageSchema = z.custom<Message>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { id?: unknown }).id === 'string' &&
    ['user', 'assistant', 'tool'].includes((v as { role?: string }).role as string),
  'invalid message',
);
/**
 * On disk: `{ version: 1, ...Chat, usageTotals }`. Parsing strips `version`, backfills `usageTotals` from the
 * messages when it is missing or malformed, and always recomputes `usage`.
 */
export const chatFileSchema: z.ZodType<StoredChat> = z
  .object({
    version: z.literal(1),
    ...chatSummaryShape,
    usageTotals: usageTotalsSchema.optional().catch(undefined),
    messages: z.array(messageSchema),
  })
  .transform(({ version: _version, usageTotals, ...chat }): StoredChat => withUsage({ ...chat, usageTotals }));

export const attachmentMetaSchema: z.ZodType<StoredAttachment> = z.object({
  id: z.string().min(1),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(['text', 'image']),
  chatId: z.string().nullable(),
  createdAt: z.string(),
});

export function summarize(chat: ChatRecord): ChatSummary {
  return {
    id: chat.id,
    projectId: chat.projectId,
    title: chat.title,
    model: chat.model,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    archived: chat.archived,
    usage: withUsage(chat).usage,
    effort: chat.effort,
  };
}
