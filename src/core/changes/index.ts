// Change sets (v0.2 plan §4.7). G1 implements this; until then every method fails loudly.

import type { ChangesService } from '../types';

const notImplemented = (what: string): never => {
  throw new Error(`ChangesService.${what} is not implemented yet (v0.2 goal G1).`);
};

export function createChangesService(): ChangesService {
  return {
    get: async () => notImplemented('get'),
    tools: () => notImplemented('tools'),
    snapshot: async () => notImplemented('snapshot'),
    restore: async () => notImplemented('restore'),
    takeNote: async () => notImplemented('takeNote'),
    apply: async () => notImplemented('apply'),
    discard: async () => notImplemented('discard'),
    removeForChat: async () => notImplemented('removeForChat'),
  };
}
