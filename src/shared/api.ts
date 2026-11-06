// HTTP API: route paths and zod request bodies (plan §4.3).
// All routes are under `/api`, JSON unless noted, and require `X-OpenVern-Client: 1`.

import { z } from 'zod';
import { LIMITS, REASONING_EFFORTS } from './constants';
import type { AppliedBatch, ChatChanges } from './types';

export const API_PREFIX = '/api';

/** Route paths relative to `API_PREFIX`, in Hono's `:param` syntax. */
export const ROUTES = {
  health: '/health',
  settings: '/settings',
  openRouterKey: '/settings/openrouter-key',
  models: '/models',
  projects: '/projects',
  project: '/projects/:id',
  chats: '/chats',
  chat: '/chats/:id',
  chatMessages: '/chats/:id/messages',
  chatRetry: '/chats/:id/retry',
  attachments: '/attachments',
  attachment: '/attachments/:id',
  attachmentContent: '/attachments/:id/content',
  projectFiles: '/projects/:id/files',
  projectFileContent: '/projects/:id/files/content',
  projectFileAttach: '/projects/:id/files/attach',
  homeFiles: '/home/files',
  homeFileContent: '/home/files/content',
  homeFileAttach: '/home/files/attach',
  chatChanges: '/chats/:id/changes',
  chatChangesApply: '/chats/:id/changes/apply',
} as const;

export interface HealthResponse {
  ok: true;
  version: string;
  mode: 'dev' | 'prod';
}

const id = z.string().min(1);
const modelId = z.string().trim().min(1);
/** F3: `null` is Default (no `reasoning` field); omitted means "keep what the chat already has". */
const reasoningEffort = z.enum(REASONING_EFFORTS);

/** `PUT /settings/openrouter-key` */
export const setOpenRouterKeyBody = z.object({ apiKey: z.string().trim().min(1) });
/** `PATCH /settings` */
export const updateSettingsBody = z.object({
  lastModel: modelId.optional(),
  lastEffort: reasoningEffort.nullable().optional(),
});
/** `POST /projects` */
export const createProjectBody = z.object({
  rootPath: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200).optional(),
});
/** `PATCH /projects/:id` */
export const renameProjectBody = z.object({ name: z.string().trim().min(1).max(200) });
/** `POST /chats` */
export const createChatBody = z.object({ projectId: id.nullable(), model: modelId });
/** `PATCH /chats/:id` */
export const updateChatBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  projectId: id.nullable().optional(),
  /** Any chat can be archived; a move keeps the flag. */
  archived: z.boolean().optional(),
});
/** `POST /chats/:id/messages` → `text/event-stream` of `AgentEvent` */
export const sendMessageBody = z
  .object({
    text: z.string(),
    attachmentIds: z.array(id).max(LIMITS.attachmentsPerMessage),
    model: modelId,
    /** F3: omitted = keep the chat's stored effort. */
    effort: reasoningEffort.nullable().optional(),
  })
  .refine((b) => b.text.trim().length > 0 || b.attachmentIds.length > 0, {
    message: 'A message needs text or at least one attachment.',
  });
/** `POST /chats/:id/retry` → `text/event-stream` of `AgentEvent` */
export const retryBody = z.object({ model: modelId, effort: reasoningEffort.nullable().optional() });
/** `POST /projects/:id/files/attach` → `AttachmentRef` */
export const attachProjectFileBody = z.object({ path: z.string().min(1) });
/** `POST /chats/:id/changes/apply` */
export const applyChangesBody = z.object({
  revision: z.number().int().nonnegative(),
  /** path → hunk id → decision. Hunks not listed are undecided and left out. */
  decisions: z.record(z.string(), z.record(z.string(), z.enum(['accepted', 'rejected']))),
});
export interface ApplyChangesResponse {
  batch: AppliedBatch;
  changes: ChatChanges;
}

export type SetOpenRouterKeyBody = z.infer<typeof setOpenRouterKeyBody>;
export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>;
export type CreateProjectBody = z.infer<typeof createProjectBody>;
export type RenameProjectBody = z.infer<typeof renameProjectBody>;
export type CreateChatBody = z.infer<typeof createChatBody>;
export type UpdateChatBody = z.infer<typeof updateChatBody>;
export type SendMessageBody = z.infer<typeof sendMessageBody>;
export type RetryBody = z.infer<typeof retryBody>;
export type AttachProjectFileBody = z.infer<typeof attachProjectFileBody>;
export type ApplyChangesBody = z.infer<typeof applyChangesBody>;
