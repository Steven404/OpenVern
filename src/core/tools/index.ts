// Project tools: read-only (plan S3) plus the v0.2 edit tools that stage proposals (G2). `getProjectTools()` is offered to the model; `renderTree` feeds the system prompt.

import { createDeleteFileTool, createEditFileTool, createWriteFileTool } from './edit-tools';
import { createListFilesTool } from './list-files';
import { createReadFileTool } from './read-file';
import type { SandboxOptions } from './sandbox';
import { createSearchTool } from './search';
import type { Tool } from './types';

/** `deniedRoots`: real absolute paths no tool can reach, even inside a project (the app's data dir, S1-M1). */
export function getProjectTools(opts: SandboxOptions = {}): Tool[] {
  return [
    createListFilesTool(opts),
    createReadFileTool(opts),
    createSearchTool(opts),
    // Edit tools stage into `ctx.changes`; the agent offers them only when the chat may propose edits (G2.4).
    createEditFileTool(opts),
    createWriteFileTool(opts),
    createDeleteFileTool(opts),
  ];
}

export { renderTree } from './tree';
