// Read-only project tools (plan S3). `getProjectTools()` is offered to the model; `renderTree` feeds the system prompt.

import { createListFilesTool } from './list-files';
import { createReadFileTool } from './read-file';
import type { SandboxOptions } from './sandbox';
import { createSearchTool } from './search';
import type { Tool } from './types';

/** `deniedRoots`: real absolute paths no tool can reach, even inside a project (the app's data dir, S1-M1). */
export function getProjectTools(opts: SandboxOptions = {}): Tool[] {
  return [createListFilesTool(opts), createReadFileTool(opts), createSearchTool(opts)];
}

export { renderTree } from './tree';
