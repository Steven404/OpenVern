// HTTP API: route paths and zod request bodies (plan §4.3).
// All routes are under `/api`, JSON unless noted, and require `X-OpenVern-Client: 1`.

import { z } from 'zod';
import { EDIT_MODES, LIMITS, REASONING_EFFORTS } from './constants';
import { TERMINAL, type TerminalReadAnswer } from './terminal';
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
  projectFileSearch: '/projects/:id/files/search',
  projectFileContent: '/projects/:id/files/content',
  projectFileAttach: '/projects/:id/files/attach',
  homeFiles: '/home/files',
  homeFileSearch: '/home/files/search',
  homeFileContent: '/home/files/content',
  homeFileAttach: '/home/files/attach',
  chatChanges: '/chats/:id/changes',
  chatChangesApply: '/chats/:id/changes/apply',
  /** POST, no body (none or `{}` accepted): undo one auto batch. → `UndoBatchResponse`. */
  chatBatchUndo: '/chats/:id/changes/batches/:batchId/undo',
  /** POST: the client's answer to a `terminal_read_request`. 204 when a waiting request took it; 404 when unknown,
   * expired or already answered. */
  chatTerminalRead: '/chats/:id/terminal-reads/:requestId',
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
const editMode = z.enum(EDIT_MODES);
/**
 * The edit mode the client showed when the user acted. Optional (older clients send none, and nothing is checked).
 * When present and different from the chat's stored mode, the request is refused with a 409 `conflict` and
 * `EDIT_MODE_CHANGED` and changes nothing, so a turn never runs, and a chat never moves, in a mode the user wasn't
 * shown.
 */
const expectedEditMode = editMode.optional();

/** The 409 `conflict` message of a request whose `expectedEditMode` differs from the chat's stored mode. */
export const EDIT_MODE_CHANGED = "This chat's edit mode changed. Check Review / Auto and send again.";

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
export const createChatBody = z.object({
  projectId: id.nullable(),
  model: modelId,
  /** Omitted = 'review'. */
  editMode: editMode.optional(),
});
/** `PATCH /chats/:id` */
export const updateChatBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  projectId: id.nullable().optional(),
  /** Any chat can be archived; a move keeps the flag. */
  archived: z.boolean().optional(),
  /** Allowed while a run is active: the agent reads the mode once at turn start, so it applies from the next turn. */
  editMode: editMode.optional(),
  /** Checked against the stored mode before anything changes (see `expectedEditMode`). A move should send it. */
  expectedEditMode,
});
/** `POST /chats/:id/messages` → `text/event-stream` of `AgentEvent` */
export const sendMessageBody = z
  .object({
    text: z.string(),
    attachmentIds: z.array(id).max(LIMITS.attachmentsPerMessage),
    model: modelId,
    /** F3: omitted = keep the chat's stored effort. */
    effort: reasoningEffort.nullable().optional(),
    /** The client can answer terminal reads (Electron with the terminal bridge), so offer `read_terminal`. */
    terminal: z.boolean().optional(),
    /** Checked under the turn's start claim; the turn then runs in exactly that mode (see `expectedEditMode`). */
    expectedEditMode,
  })
  .refine((b) => b.text.trim().length > 0 || b.attachmentIds.length > 0, {
    message: 'A message needs text or at least one attachment.',
  });
/** `POST /chats/:id/retry` → `text/event-stream` of `AgentEvent` */
export const retryBody = z.object({
  model: modelId,
  effort: reasoningEffort.nullable().optional(),
  /** As in `sendMessageBody`. */
  terminal: z.boolean().optional(),
  /** As in `sendMessageBody`. */
  expectedEditMode,
});
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
/** `POST /chats/:id/changes/batches/:batchId/undo`: no fields; an empty body or `{}` is accepted. */
export const undoBatchBody = z.object({});
/** `POST /chats/:id/changes/batches/:batchId/undo`. */
export interface UndoBatchResponse {
  batch: AppliedBatch; // with `undo` set
  changes: ChatChanges;
}

// Terminal reads (docs/terminal-plan.md §4.2). The renderer relays main's answer, so every size is bounded here: the
// text it carries is bound for the model.
const lineNumber = z
  .number()
  .int()
  .nonnegative()
  .max(TERMINAL.scrollbackLines + TERMINAL.maxRows);
/**
 * The line-number rules of `TerminalReadResult`: either the empty result (0, 0, ''), or a range inside the buffer of
 * at most `readMaxLines` lines whose text has exactly that many lines.
 */
function isConsistentRead(r: { totalLines: number; startLine: number; endLine: number; text: string }): boolean {
  if (r.startLine === 0 || r.endLine === 0) return r.startLine === 0 && r.endLine === 0 && r.text === '';
  if (r.startLine > r.endLine || r.endLine > r.totalLines || r.endLine - r.startLine >= TERMINAL.readMaxLines) {
    return false;
  }
  // One line of text per line in the range, joined by `\n` with no trailing one, so line numbers can be trusted.
  let lines = 1;
  for (let i = r.text.indexOf('\n'); i !== -1; i = r.text.indexOf('\n', i + 1)) lines++;
  return lines === r.endLine - r.startLine + 1;
}
/**
 * A read's text is an emulator's plain text, which never holds C0 controls (other than tab and line feed), DEL or C1
 * controls. An answer that does is refused whole rather than cleaned: removing an escape sequence can take the first
 * character of a key with it, and redacting before the removal can split a key that a control was hiding, so no
 * order of cleaning and redacting is safe.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const TERMINAL_TEXT_FORBIDDEN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const terminalStatus = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running') }),
  z.object({
    state: z.literal('exited'),
    exitCode: z.number().int().nullable(),
    signal: z.number().int().nullable(),
  }),
]);
const terminalInfo = z.object({
  chatId: id.max(200),
  shell: z.string().max(255),
  cwd: z.string().max(4096),
  cols: z.number().int().min(TERMINAL.minCols).max(TERMINAL.maxCols),
  rows: z.number().int().min(TERMINAL.minRows).max(TERMINAL.maxRows),
  status: terminalStatus,
});
/** `POST /chats/:id/terminal-reads/:requestId`: the zod form of `TerminalReadAnswer`. */
export const terminalReadAnswerBody = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    result: z
      .object({
        info: terminalInfo,
        totalLines: lineNumber,
        startLine: lineNumber,
        endLine: lineNumber,
        text: z
          .string()
          .max(TERMINAL.readWireMaxChars)
          .refine((text) => !TERMINAL_TEXT_FORBIDDEN.test(text), {
            message: 'The text contains control characters.',
          }),
        truncated: z.boolean(),
      })
      .refine(isConsistentRead, { message: 'The line numbers and the text do not fit together.' }),
  }),
  z.object({ ok: z.literal(false), reason: z.enum(['no_terminal', 'unavailable']) }),
]) satisfies z.ZodType<TerminalReadAnswer>;

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
export type TerminalReadAnswerBody = z.infer<typeof terminalReadAnswerBody>;
