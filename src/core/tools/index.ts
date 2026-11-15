// Project tools: read-only (plan S3) plus the v0.2 edit tools that stage proposals (G2). `getProjectTools()` is offered to the model; `renderTree` feeds the system prompt.
// Terminal tools (`read_terminal`) need no project and are offered in any chat whose client can answer terminal reads.

import { createDeleteFileTool, createEditFileTool, createWriteFileTool } from './edit-tools';
import { createListFilesTool } from './list-files';
import { createReadFileTool } from './read-file';
import { createReadTerminalTool } from './read-terminal';
import type { SandboxOptions } from './sandbox';
import { createSearchTool } from './search';
import type { ChatToolContext, Tool } from './types';

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

/** Tools that need no project: offered in every chat when the client can answer terminal reads (terminal plan T2.3). */
export function getTerminalTools(): Tool<ChatToolContext>[] {
  return [createReadTerminalTool()];
}

export { renderTree } from './tree';
