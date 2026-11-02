// Tool interface (plan §4.7). Implementations live in S3.

import type { ChangeKind, ChangeSummary, FileChange } from '@shared/types';
import type { ToolSpec } from '../providers/types';

export interface ToolContext {
  projectRoot: string;
  signal: AbortSignal;
  /** Exact secret values (the app's stored key) to redact from anything read from disk (plan K1). */
  knownSecrets?: readonly string[];
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

export interface Tool {
  spec: ToolSpec;
  /** Never throws; bad args → `ok: false` with a message the model can act on. */
  run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// S3 exports from `./index`:
//   getProjectTools(): Tool[]
//   renderTree(root: string, opts: { depth: number; maxEntries: number }): Promise<string>
export type GetProjectTools = () => Tool[];
export type RenderTree = (
  root: string,
  opts: { depth: number; maxEntries: number; signal?: AbortSignal },
) => Promise<string>;
