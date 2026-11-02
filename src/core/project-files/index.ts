// Read-only project file browsing for the Files panel (v0.2 plan §4.7). G3 implements this.

import type { ProjectFilesService } from '../types';

const notImplemented = (what: string): never => {
  throw new Error(`ProjectFilesService.${what} is not implemented yet (v0.2 goal G3).`);
};

export function createProjectFilesService(): ProjectFilesService {
  return {
    tree: async () => notImplemented('tree'),
    read: async () => notImplemented('read'),
  };
}
