// Domain types shared by core, server and renderer (plan §4.1).

import type { ApiErrorInfo } from './errors';

export type Id = string; // crypto.randomUUID()
export type IsoDate = string; // new Date().toISOString()

export interface Project {
  id: Id;
  name: string;
  rootPath: string; // absolute, realpath'd
  createdAt: IsoDate;
}
export interface ProjectListItem extends Project {
  chatCount: number;
  /** A `.git` directory or file exists in the project folder or one of its ancestors. Computed on every list. */
  inGitRepo: boolean;
}

/**
 * What the chat's context holds and what it has cost (F1, plan §4.1). Built by storage from the chat's
 * `usageTotals` and its messages; the trailing `chat_updated` of a run carries it.
 */
export interface ChatUsage {
  /** prompt + completion tokens of the latest assistant message with usage; 0 when none. */
  contextTokens: number;
  /** Cumulative over every provider request in the chat, including retried and truncated ones. */
  promptTokens: number;
  completionTokens: number;
  /** Sum of reported costs; null when no request has reported one. */
  costUsd: number | null;
  /** Number of provider requests counted. 0 = the counter is hidden. */
  requests: number;
}

/**
 * F3: a reasoning effort OpenRouter understands. `null` means Default: no `reasoning` field is sent (plan §4.1).
 * `REASONING_EFFORTS` lists them in order (constants.ts).
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** How the model's edits reach the disk in a chat. New chats start in 'review'. A change applies from the next turn. */
export type EditMode = 'review' | 'auto';

export interface ChatSummary {
  id: Id;
  projectId: Id | null; // null = loose chat ("Chats" section), no tools
  title: string; // "New chat" until auto-titled
  model: string; // model used for the latest turn
  createdAt: IsoDate;
  updatedAt: IsoDate;
  /** Hidden under "Archived" (in "Chats" or inside its project) in the sidebar. */
  archived: boolean;
  usage: ChatUsage;
  /** Effort of the latest turn; null = the model's own setting (F3). */
  effort: ReasoningEffort | null;
  /** 'auto': the edit tools write to disk as they run. The agent reads it once, at the start of each turn. */
  editMode: EditMode;
}
export interface Chat extends ChatSummary {
  messages: Message[];
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface UserMessage {
  id: Id;
  role: 'user';
  createdAt: IsoDate;
  text: string;
  attachments: AttachmentRef[];
  /** Provider-only: what happened to proposed edits since the previous turn. Never shown in the UI. */
  changesNote?: string;
}

export interface AssistantMessage {
  id: Id;
  role: 'assistant';
  createdAt: IsoDate;
  model: string;
  text: string; // markdown
  toolCalls: ToolCall[]; // in the order the model requested them
  status: 'complete' | 'stopped' | 'error';
  error?: ApiErrorInfo;
  usage?: Usage;
  providerMeta?: unknown; // opaque; the provider adapter round-trips it (e.g. OpenRouter reasoning_details)
  /** UI-only note shown under the message; never sent to the provider. */
  notice?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  argsJson: string; // raw JSON string from the model
}

export interface ToolMessage {
  id: Id;
  role: 'tool';
  createdAt: IsoDate;
  toolCallId: string;
  name: string;
  ok: boolean;
  output: string; // exactly what was sent back to the model (already truncated)
  summary: string; // short UI label, e.g. "src/agent/loop.ts" or "\"useEffect\" in src/"
  durationMs: number;
}

export interface AttachmentRef {
  id: Id;
  name: string;
  mime: string;
  size: number;
  kind: 'text' | 'image';
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
}

export interface ModelInfo {
  id: string; // "anthropic/claude-…"
  name: string; // OpenRouter display name, e.g. "Anthropic: Claude …"
  contextLength: number | null;
  supportsTools: boolean; // supported_parameters includes "tools"
  supportsImages: boolean; // architecture.input_modalities includes "image"
  promptPricePerMTok: number | null;
  completionPricePerMTok: number | null;
  /** OpenRouter's model description. Optional so 0.1 model caches still load. */
  description?: string;
  /** Display name of the maker, e.g. "DeepSeek". */
  author?: string;
  /**
   * `supported_parameters` includes "reasoning" (F3). Optional so model caches written before F3 still load;
   * missing counts as false.
   */
  supportsReasoning?: boolean;
  /**
   * F3 follow-up: the levels OpenRouter says the model accepts, ordered as in `REASONING_EFFORTS` (none→max).
   * Optional and absent when the model publishes none: the picker is then hidden and no `reasoning.effort` is sent.
   */
  reasoningEfforts?: ReasoningEffort[];
  /**
   * F3 follow-up: OpenRouter's default level for the model, when it is a level we know. Display only; choosing
   * Default always sends no `reasoning` field.
   */
  defaultEffort?: ReasoningEffort;
}

export interface PublicSettings {
  openRouter: { configured: boolean; keyHint: string | null };
  lastModel: string | null;
  /** Effort a new chat starts from (F3); null = Default. */
  lastEffort: ReasoningEffort | null;
}

// ── v0.2: proposed edits (plan §4.1) ──────────────────────────────────────────────────────────

export type ChangeKind = 'create' | 'modify' | 'delete';
export type HunkDecision = 'accepted' | 'rejected';

export interface DiffHunk {
  /** `${oldStart}:${8-char hash of lines}`. Stable while that file's proposal is unchanged. */
  id: string;
  oldStart: number; // 1-based; 0 for a new file
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Nearest enclosing declaration above the hunk (best effort), '' when none. The label after the range. */
  header: string;
  /** Unified lines, each prefixed with ' ', '+' or '-'. */
  lines: string[];
}

export interface FileChange {
  path: string; // project-relative, forward slashes
  kind: ChangeKind;
  add: number;
  del: number;
  hunks: DiffHunk[];
  /** True when the diff has more than LIMITS.diffMaxLinesPerFile lines; `hunks` is then empty. */
  tooLarge?: boolean;
}

export interface PendingChanges {
  /** Bumps whenever the proposal changes. Apply must echo it. */
  revision: number;
  /** The assistant message that last changed the proposal. The card sits under its turn. */
  messageId: Id;
  files: FileChange[]; // sorted by path
  totalAdd: number;
  totalDel: number;
}

export type ApplyConflictReason = 'changed_on_disk' | 'deleted_on_disk' | 'exists_on_disk' | 'blocked' | 'too_large';

export type UndoSkipReason =
  | 'changed_since' // the file is no longer byte-identical to what the turn left
  | 'blocked' // the sandbox refuses the path now, or the write failed
  | 'unavailable'; // the stored original is missing

export interface BatchUndo {
  at: IsoDate;
  /** 'user': the Undo button. 'retry': a retry of the turn undid it first. */
  by: 'user' | 'retry';
  restored: string[]; // sorted paths
  skipped: { path: string; reason: UndoSkipReason }[];
}

export interface AppliedBatch {
  id: Id;
  appliedAt: IsoDate;
  messageId: Id; // PendingChanges.messageId at apply time
  written: FileChange[]; // only the accepted hunks, as written
  rejectedHunks: number;
  skippedHunks: number; // undecided at apply time
  conflicts: { path: string; reason: ApplyConflictReason }[];
  /** 'review': the user applied proposals. 'auto': what the model wrote during one turn in Auto. */
  source: 'review' | 'auto';
  /** Auto: the user message that started the turn. */
  turnId?: Id;
  /** Auto: not undone, within the kept turns, and its project is still the chat's project. Always false for review. */
  undoable: boolean;
  undo?: BatchUndo;
}
// For an auto batch: `appliedAt` = time of its latest write; `messageId` = the assistant message of its first write
// (places the card in the turn); `written` = one FileChange per file, from before the turn's first write to after its
// last; `rejectedHunks` / `skippedHunks` = 0; `conflicts` = [] (refusals are tool errors, not conflicts).

export interface ChatChanges {
  pending: PendingChanges | null;
  applied: AppliedBatch[]; // oldest first
  /** Bumps whenever this chat changed project files: apply, auto write, undo. The Files panel refreshes on it. */
  diskSeq: number;
}

/** The light form used by stream events and the card (no hunks). */
export interface ChangeSummary {
  revision: number;
  messageId: Id;
  files: { path: string; kind: ChangeKind; add: number; del: number }[];
  totalAdd: number;
  totalDel: number;
}

export interface ProjectFileEntry {
  path: string; // root-relative (project or home), forward slashes
  type: 'file' | 'dir';
}
/** One folder of the Files panel: its direct children only. */
export interface ProjectFileListing {
  /** The folder listed, root-relative POSIX (`''` for the root). */
  path: string;
  entries: ProjectFileEntry[]; // sorted: dirs first, then case-insensitive name
  /** More than `LIMITS.fileTreeFolderMaxEntries` children: only the first ones are listed. */
  truncated: boolean;
}
/** The Files panel when a chat has no project: the same listing, rooted at the user's home directory. */
export interface HomeFileListing extends ProjectFileListing {
  /** Absolute home path, shown as the tree title. */
  root: string;
}
/** The Files panel filter: files whose root-relative path contains the query (case-insensitive), in walk order. */
export interface ProjectFileSearchResult {
  entries: ProjectFileEntry[];
  /**
   * Why the search stopped early, or `false` when it saw everything:
   * - `'results'`: `LIMITS.fileSearchMaxResults` matches were found; more may exist (narrow the query);
   * - `'scanned'`: the walk stopped after `LIMITS.fileSearchMaxScanned` entries (or was aborted), so part of the tree
   *   was never searched and matches there are missing, however many were found.
   */
  truncated: false | 'results' | 'scanned';
}
export interface ProjectFileContent {
  path: string;
  size: number;
  totalLines: number;
  content: string | null; // null when binary
  binary: boolean;
  truncated: boolean; // over LIMITS.viewerMaxBytes: content is the first part
}
