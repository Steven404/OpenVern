// Test-only in-memory `ChangesService` (G3 route tests). Stands in for G1's `createChangesService` behind the same
// interface: it holds a seeded pending set, enforces the revision, records an applied batch and never touches disk.

import type { ApplyChangesResponse } from '@shared/api';
import type { AppliedBatch, ChatChanges, Id, PendingChanges } from '@shared/types';
import { CoreError } from '../core/errors';
import type { ChangesService } from '../core/types';

export interface MemoryChanges extends ChangesService {
  /** Puts a pending set on a chat. */
  seed(chatId: Id, pending: PendingChanges): void;
  /** Every `apply` call received, for assertions. */
  applyCalls: Parameters<ChangesService['apply']>[0][];
}

export function createMemoryChanges(): MemoryChanges {
  const state = new Map<Id, ChatChanges>();
  const of = (chatId: Id): ChatChanges => {
    let s = state.get(chatId);
    if (!s) {
      s = { pending: null, applied: [] };
      state.set(chatId, s);
    }
    return s;
  };
  const copy = (s: ChatChanges): ChatChanges => structuredClone(s);
  const applyCalls: MemoryChanges['applyCalls'] = [];

  return {
    applyCalls,
    seed: (chatId, pending) => {
      of(chatId).pending = pending;
    },
    get: async (chatId) => copy(of(chatId)),
    tools: () => {
      throw new Error('memory ChangesService: tools() is not implemented');
    },
    snapshot: async () => {},
    restore: async () => {},
    takeNote: async () => undefined,
    apply: async (input): Promise<ApplyChangesResponse> => {
      applyCalls.push(input);
      const s = of(input.chatId);
      if (!s.pending || s.pending.revision !== input.revision) throw new CoreError('changes_stale');
      let accepted = 0;
      let rejected = 0;
      let total = 0;
      for (const f of s.pending.files) {
        for (const h of f.hunks) {
          total++;
          const d = input.decisions[f.path]?.[h.id];
          if (d === 'accepted') accepted++;
          else if (d === 'rejected') rejected++;
        }
      }
      const batch: AppliedBatch = {
        id: `batch-${s.applied.length + 1}`,
        appliedAt: new Date().toISOString(),
        messageId: s.pending.messageId,
        written: accepted > 0 ? s.pending.files : [],
        rejectedHunks: rejected,
        skippedHunks: total - accepted - rejected,
        conflicts: [],
      };
      s.applied.push(batch);
      s.pending = null;
      return { batch: structuredClone(batch), changes: copy(s) };
    },
    discard: async (chatId) => {
      const s = of(chatId);
      s.pending = null;
      return copy(s);
    },
    removeForChat: async (chatId) => {
      state.delete(chatId);
    },
  };
}
