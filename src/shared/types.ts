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
}

export interface ChatSummary {
  id: Id;
  projectId: Id | null; // null = loose chat ("Chats" section), no tools
  title: string; // "New chat" until auto-titled
  model: string; // model used for the latest turn
  createdAt: IsoDate;
  updatedAt: IsoDate;
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
}

export interface PublicSettings {
  openRouter: { configured: boolean; keyHint: string | null };
  lastModel: string | null;
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

export type ApplyConflictReason = 'changed_on_disk' | 'deleted_on_disk' | 'exists_on_disk' | 'blocked';

export interface AppliedBatch {
  id: Id;
  appliedAt: IsoDate;
  messageId: Id; // PendingChanges.messageId at apply time
  written: FileChange[]; // only the accepted hunks, as written
  rejectedHunks: number;
  skippedHunks: number; // undecided at apply time
  conflicts: { path: string; reason: ApplyConflictReason }[];
}

export interface ChatChanges {
  pending: PendingChanges | null;
  applied: AppliedBatch[]; // oldest first
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
  path: string; // project-relative, forward slashes
  type: 'file' | 'dir';
}
export interface ProjectFileTree {
  entries: ProjectFileEntry[]; // sorted: dirs first, then case-insensitive name, depth-first
  truncated: boolean;
}
export interface ProjectFileContent {
  path: string;
  size: number;
  totalLines: number;
  content: string | null; // null when binary
  binary: boolean;
  truncated: boolean; // over LIMITS.viewerMaxBytes: content is the first part
}
