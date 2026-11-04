// zod schemas for the files in plan §3.5. Message-level validation is deliberately loose so that a small
// shape drift never makes a whole chat unreadable; the TypeScript types are the real contract.

import type { Chat, ChatSummary, Message, Project } from '@shared/types';
import { z } from 'zod';
import type { StoredAttachment } from '../types';

export const settingsFileSchema = z.object({
  version: z.literal(1),
  lastModel: z.string().nullable().default(null),
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

const chatSummaryShape = {
  id: z.string().min(1),
  projectId: z.string().nullable(),
  title: z.string(),
  model: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // `.catch`, not `.default`: a missing or malformed flag loads as false instead of quarantining the file.
  archived: z.boolean().catch(false),
};
const chatSummarySchema: z.ZodType<ChatSummary> = z.object(chatSummaryShape);
export const chatIndexSchema = z.object({ version: z.literal(1), chats: z.array(chatSummarySchema) });
export type ChatIndexFile = z.infer<typeof chatIndexSchema>;

const messageSchema = z.custom<Message>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { id?: unknown }).id === 'string' &&
    ['user', 'assistant', 'tool'].includes((v as { role?: string }).role as string),
  'invalid message',
);
/** On disk: `{ version: 1, ...Chat }`. Parsing strips `version`. */
export const chatFileSchema: z.ZodType<Chat> = z
  .object({ version: z.literal(1), ...chatSummaryShape, messages: z.array(messageSchema) })
  .transform(({ version: _version, ...chat }): Chat => chat);

export const attachmentMetaSchema: z.ZodType<StoredAttachment> = z.object({
  id: z.string().min(1),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(['text', 'image']),
  chatId: z.string().nullable(),
  createdAt: z.string(),
});

export function summarize(chat: ChatSummary): ChatSummary {
  return {
    id: chat.id,
    projectId: chat.projectId,
    title: chat.title,
    model: chat.model,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    archived: chat.archived,
  };
}
