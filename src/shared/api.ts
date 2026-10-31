// HTTP API: route paths and zod request bodies (plan §4.3).
// All routes are under `/api`, JSON unless noted, and require `X-Harness-Client: 1`.

import { z } from 'zod';
import { LIMITS } from './constants';

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
} as const;

export interface HealthResponse {
  ok: true;
  version: string;
  mode: 'dev' | 'prod';
}

const id = z.string().min(1);
const modelId = z.string().trim().min(1);

/** `PUT /settings/openrouter-key` */
export const setOpenRouterKeyBody = z.object({ apiKey: z.string().trim().min(1) });
/** `PATCH /settings` */
export const updateSettingsBody = z.object({ lastModel: modelId.optional() });
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
});
/** `POST /chats/:id/messages` → `text/event-stream` of `AgentEvent` */
export const sendMessageBody = z
  .object({ text: z.string(), attachmentIds: z.array(id).max(LIMITS.attachmentsPerMessage), model: modelId })
  .refine((b) => b.text.trim().length > 0 || b.attachmentIds.length > 0, {
    message: 'A message needs text or at least one attachment.',
  });
/** `POST /chats/:id/retry` → `text/event-stream` of `AgentEvent` */
export const retryBody = z.object({ model: modelId });

export type SetOpenRouterKeyBody = z.infer<typeof setOpenRouterKeyBody>;
export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>;
export type CreateProjectBody = z.infer<typeof createProjectBody>;
export type RenameProjectBody = z.infer<typeof renameProjectBody>;
export type CreateChatBody = z.infer<typeof createChatBody>;
export type UpdateChatBody = z.infer<typeof updateChatBody>;
export type SendMessageBody = z.infer<typeof sendMessageBody>;
export type RetryBody = z.infer<typeof retryBody>;
