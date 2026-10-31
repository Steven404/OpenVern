// Tool interface (plan §4.7). Implementations live in S3.

import type { ToolSpec } from '../providers/types';

export interface ToolContext {
  projectRoot: string;
  signal: AbortSignal;
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
export type RenderTree = (root: string, opts: { depth: number; maxEntries: number }) => Promise<string>;
