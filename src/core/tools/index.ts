// Project tools: read-only (plan S3) plus the edit tools (staged as proposals in Review, written in Auto). `getProjectTools()` is offered to the model; `renderTree` feeds the system prompt.
// Terminal tools (`read_terminal`) need no project and are offered in any chat whose client can answer terminal reads.

import { createDeleteFileTool, createEditFileTool, createWriteFileTool, type EditToolOptions } from './edit-tools';
import { createListFilesTool } from './list-files';
import { createReadFileTool } from './read-file';
import { createReadTerminalTool } from './read-terminal';
import { createSearchTool } from './search';
import type { ChatToolContext, Tool } from './types';

/**
 * `deniedRoots`: real absolute paths no tool can reach, even inside a project (the app's data dir, S1-M1).
 * `editMode`: which edit mode the edit tools' descriptions describe (default 'review').
 */
export function getProjectTools(opts: EditToolOptions = {}): Tool[] {
  return [
    createListFilesTool(opts),
    createReadFileTool(opts),
    createSearchTool(opts),
    // Edit tools go through `ctx.changes` (staged in Review, written in Auto); the agent offers them only when the
    // chat may edit.
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
