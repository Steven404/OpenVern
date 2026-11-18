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
 * The edit mode the client showed when the user acted. A mismatch with the chat's stored mode is refused with a 409
 * `conflict` and `EDIT_MODE_CHANGED` and changes nothing, so a turn never runs, and a chat never moves or switches,
 * in a mode the user wasn't shown. On a send, a retry or a move, omitted means `'review'`: a request that showed
 * nothing can only start a Review turn (which writes nothing without approval) or move a Review chat. Running or
 * moving an Auto chat needs an explicit `'auto'` that some UI drew.
 */
const expectedEditMode = editMode.optional();
/**
 * The project the client showed when the user sent or retried (`null` = no project). A mismatch with the chat's
 * project, read under the same start claim as the mode, is refused with a 409 `conflict` and `CHAT_PROJECT_CHANGED`
 * and persists nothing, so a turn never runs in a project the sender didn't see. Omitted means unchecked.
 */
const expectedProjectId = id.nullable().optional();
/**
 * Whether the client showed the target project's folder as inside Git, on a request that turns Auto on or keeps it on
 * in another project. The server checks the folder again when it commits: if it is outside Git now and the client
 * didn't show it so (`true` or omitted), it refuses with a 409 `conflict` and `PROJECT_NOT_IN_GIT` and changes
 * nothing, so a stale "in Git" can't skip the no-Git warning. `false` (the client showed the folder outside Git, so
 * its warning was decided) is never refused for this.
 */
const expectedInGitRepo = z.boolean().optional();

/** The 409 `conflict` message of a request whose `expectedEditMode` differs from the chat's stored mode. */
export const EDIT_MODE_CHANGED = "This chat's edit mode changed. Check Review / Auto and send again.";
/** The 409 `conflict` message of a request whose `expectedProjectId` differs from the chat's stored project. */
export const CHAT_PROJECT_CHANGED = 'This chat moved to another project. Check Review / Auto and try again.';
/**
 * The 409 `conflict` message of an Apply whose proposals were made for another project than the chat's current one.
 * Nothing is written; the proposals stay pending until they are discarded or the chat is moved back.
 */
export const PROPOSALS_OTHER_PROJECT =
  'These proposed edits were made for another project. Discard them or move the chat back.';
/** The 409 `conflict` message of an Apply whose `expectedProjectId` differs from the chat's current project. */
export const APPLY_PROJECT_CHANGED = 'This chat moved to another project. Check the proposed edits and apply again.';
/** The 409 `conflict` message of a request that would run Auto in a folder its client showed as inside Git. */
export const PROJECT_NOT_IN_GIT =
  "This project's folder is no longer a Git repository. Check the warning and try again.";

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
  /** Checked with `editMode: 'auto'` in a project (see `expectedInGitRepo`). */
  expectedInGitRepo,
});
/** `PATCH /chats/:id` */
export const updateChatBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  projectId: id.nullable().optional(),
  /** Any chat can be archived; a move keeps the flag. */
  archived: z.boolean().optional(),
  /** Allowed while a run is active: the agent reads the mode once at turn start, so it applies from the next turn. */
  editMode: editMode.optional(),
  /**
   * Checked against the stored mode, under the lock that commits the change (see `expectedEditMode`). With
   * `projectId` (a move), omitted means `'review'`; otherwise omitted means unchecked.
   */
  expectedEditMode,
  /**
   * Checked against the stored project under the same lock; a mismatch is a 409 `CHAT_PROJECT_CHANGED` and changes
   * nothing. Turning Auto on sends the project whose no-Git warning was decided, so a move that lands first can't
   * carry Auto into a project the user wasn't warned about.
   */
  expectedProjectId,
  /** Checked when the PATCH turns Auto on in a project, or moves an Auto chat into another one (`expectedInGitRepo`). */
  expectedInGitRepo,
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
    /**
     * Checked under the turn's start claim; the turn then runs in exactly that mode (see `expectedEditMode`).
     * Omitted means `'review'`.
     */
    expectedEditMode,
    /** Checked under the same claim; the turn runs in exactly that project (see `expectedProjectId`). */
    expectedProjectId,
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
  /** As in `sendMessageBody` (omitted means `'review'`). */
  expectedEditMode,
  /** As in `sendMessageBody` (omitted means unchecked). */
  expectedProjectId,
});
/** `POST /projects/:id/files/attach` → `AttachmentRef` */
export const attachProjectFileBody = z.object({ path: z.string().min(1) });
/** `POST /chats/:id/changes/apply` */
export const applyChangesBody = z.object({
  revision: z.number().int().nonnegative(),
  /** path → hunk id → decision. Hunks not listed are undecided and left out. */
  decisions: z.record(z.string(), z.record(z.string(), z.enum(['accepted', 'rejected']))),
  /**
   * The project the client showed with the proposals (`null` = no project). Refused with a 409 `conflict` and
   * `APPLY_PROJECT_CHANGED`, writing nothing, unless it is the chat's current project. Omitted means unchecked: the
   * proposals' own project is still compared with the chat's current one (`PROPOSALS_OTHER_PROJECT`), so nothing is
   * ever written into a project the proposals weren't made for.
   */
  expectedProjectId,
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
