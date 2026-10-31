// Read-only project tools (plan S3). `getProjectTools()` is offered to the model; `renderTree` feeds the system prompt.

import { createListFilesTool } from './list-files';
import { createReadFileTool } from './read-file';
import { createSearchTool } from './search';
import type { Tool } from './types';

export function getProjectTools(): Tool[] {
  return [createListFilesTool(), createReadFileTool(), createSearchTool()];
}

export { renderTree } from './tree';
