// Tool interface (plan §4.7). Implementations live in S3.

import type { TerminalReadAnswer, TerminalReadRequest } from '@shared/terminal';
import type { ChangeKind, ChangeSummary, FileChange } from '@shared/types';
import type { ToolSpec } from '../providers/types';

/** What every tool gets, in any chat. Tools that need nothing from a project (`read_terminal`) take only this. */
export interface ChatToolContext {
  signal: AbortSignal;
  /** Exact secret values (the app's stored key) to redact from anything read from disk (plan K1). */
  knownSecrets?: readonly string[];
  /** Present only when the client can answer terminal reads (`RunTurnInput.terminal`). Used by `read_terminal`. */
  terminal?: { read(request: TerminalReadRequest): Promise<TerminalReadAnswer> };
}

/** What a project tool gets: the chat context plus the project it works in. */
export interface ToolContext extends ChatToolContext {
  projectRoot: string;
  /** Present only when this chat may propose edits. Read tools use it as an overlay. */
  changes?: ToolChanges;
}

export interface ToolChanges {
  /** null = not staged, read the disk. */
  read(relPath: string): Promise<{ kind: 'staged'; content: string } | { kind: 'deleted' } | null>;
  staged(): Promise<{ path: string; kind: ChangeKind }[]>;
  /** content null = delete. Validates (plan §3.3) and returns the new summary (null when the set became empty). */
  stage(relPath: string, content: string | null): Promise<{ file: FileChange | null; summary: ChangeSummary | null }>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  summary: string;
}

/**
 * `C` is the context the tool needs: `ToolContext` (the default) for project tools, `ChatToolContext` for tools offered
 * in any chat. `run` is a property, not a method, so it is checked contravariantly: a `Tool<ChatToolContext>` can be
 * used where a project tool is expected, but a project tool never passes as one that runs without a project.
 */
export interface Tool<C extends ChatToolContext = ToolContext> {
  spec: ToolSpec;
  /** Never throws; bad args → `ok: false` with a message the model can act on. */
  run: (rawArgs: unknown, ctx: C) => Promise<ToolResult>;
}

// S3 exports from `./index`:
//   getProjectTools(): Tool[]
//   renderTree(root: string, opts: { depth: number; maxEntries: number }): Promise<string>
export type GetProjectTools = () => Tool[];
/** Tools offered in every chat, project or not, when the client can answer terminal reads (terminal plan T2.3). */
export type GetTerminalTools = () => Tool<ChatToolContext>[];
export type RenderTree = (
  root: string,
  opts: { depth: number; maxEntries: number; signal?: AbortSignal },
) => Promise<string>;
