// Test-only in-memory `ChangesService` for the route tests. Stands in for `createChangesService` behind the same
// interface: it holds a seeded pending set and seeded auto batches, enforces the revision, the apply project rule
// (the set's project and the shown one must be the chat's current project) and the undo rules (auto, not undone,
// within retention, same project), records what it was asked, and never touches disk.

import {
  APPLY_PROJECT_CHANGED,
  type ApplyChangesResponse,
  PROPOSALS_OTHER_PROJECT,
  type UndoBatchResponse,
} from '@shared/api';
import type { AppliedBatch, BatchUndo, ChatChanges, Id, PendingChanges } from '@shared/types';
import { CoreError } from '../core/errors';
import type { ChangesService } from '../core/types';

export interface MemoryChanges extends ChangesService {
  /** Puts a pending set on a chat, made for `opts.projectId` (omitted = unbound: the chat's current project). */
  seed(chatId: Id, pending: PendingChanges, opts?: { projectId?: Id }): void;
  /**
   * Adds a batch to a chat's history (newest last). An auto batch needs `projectId`, the project it was written into;
   * it is undoable while `undoable` is true and it has no `undo` (seed `undoable: false` for one past retention).
   */
  seedBatch(chatId: Id, batch: AppliedBatch, opts?: { projectId?: Id }): void;
  /** Every `apply` call received, for assertions. */
  applyCalls: Parameters<ChangesService['apply']>[0][];
  /** Every `undoBatch` call received. */
  undoCalls: Parameters<ChangesService['undoBatch']>[0][];
  /** Every `prepareRetry` call received. */
  retryCalls: Parameters<ChangesService['prepareRetry']>[0][];
}

export function createMemoryChanges(): MemoryChanges {
  const state = new Map<Id, ChatChanges>();
  const of = (chatId: Id): ChatChanges => {
    let s = state.get(chatId);
    if (!s) {
      s = { pending: null, applied: [], diskSeq: 0 };
      state.set(chatId, s);
    }
    return s;
  };
  const copy = (s: ChatChanges): ChatChanges => structuredClone(s);
  const applyCalls: MemoryChanges['applyCalls'] = [];
  const undoCalls: MemoryChanges['undoCalls'] = [];
  const retryCalls: MemoryChanges['retryCalls'] = [];
  /** batch id → the project an auto batch was written into. */
  const batchProject = new Map<Id, Id>();
  /** chat id → the project its pending set was made for. */
  const pendingProject = new Map<Id, Id>();

  /** Undoes a seeded auto batch in place: every written file counts as restored. */
  const undoInPlace = (s: ChatChanges, batch: AppliedBatch, by: BatchUndo['by']): BatchUndo => {
    const undo: BatchUndo = {
      at: new Date().toISOString(),
      by,
      restored: batch.written.map((f) => f.path).sort(),
      skipped: [],
    };
    batch.undo = undo;
    batch.undoable = false;
    if (undo.restored.length > 0) s.diskSeq += 1;
    return undo;
  };
  const canUndo = (batch: AppliedBatch, projectId: Id): boolean =>
    batch.source === 'auto' && batch.undoable && !batch.undo && batchProject.get(batch.id) === projectId;

  return {
    applyCalls,
    undoCalls,
    retryCalls,
    seed: (chatId, pending, opts) => {
      of(chatId).pending = pending;
      if (opts?.projectId !== undefined) pendingProject.set(chatId, opts.projectId);
      else pendingProject.delete(chatId);
    },
    seedBatch: (chatId, batch, opts) => {
      of(chatId).applied.push(structuredClone(batch));
      if (opts?.projectId !== undefined) batchProject.set(batch.id, opts.projectId);
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
      if (s.pending && (pendingProject.get(input.chatId) ?? input.projectId) !== input.projectId) {
        throw new CoreError('conflict', PROPOSALS_OTHER_PROJECT);
      }
      if (input.expectedProjectId !== undefined && input.expectedProjectId !== input.projectId) {
        throw new CoreError('conflict', APPLY_PROJECT_CHANGED);
      }
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
        source: 'review',
        undoable: false,
      };
      s.applied.push(batch);
      if (accepted > 0) s.diskSeq += 1;
      s.pending = null;
      pendingProject.delete(input.chatId);
      return { batch: structuredClone(batch), changes: copy(s) };
    },
    discard: async (chatId) => {
      const s = of(chatId);
      s.pending = null;
      pendingProject.delete(chatId);
      return copy(s);
    },
    // Nothing here can interleave (no await between the check and `commit`'s start), so there's no lock to take.
    changeProject: async (chatId, commit) =>
      commit({
        pending: of(chatId).pending !== null,
        discard: async () => {
          of(chatId).pending = null;
          pendingProject.delete(chatId);
        },
      }),
    undoBatch: async (input): Promise<UndoBatchResponse> => {
      undoCalls.push(input);
      const s = of(input.chatId);
      const batch = s.applied.find((b) => b.id === input.batchId);
      if (!batch) throw new CoreError('not_found', 'These edits were not found.');
      if (!canUndo(batch, input.projectId)) throw new CoreError('conflict', 'These edits can no longer be undone.');
      undoInPlace(s, batch, 'user');
      return { batch: structuredClone(batch), changes: copy(s) };
    },
    prepareRetry: async (input) => {
      retryCalls.push(input);
      const s = of(input.chatId);
      let result: { batchId: Id; undo: BatchUndo } | null = null;
      for (const batch of s.applied) {
        if (batch.turnId !== input.turnId || !canUndo(batch, input.projectId)) continue;
        const undo = undoInPlace(s, batch, 'retry');
        result = {
          batchId: batch.id,
          undo: result ? { ...undo, restored: [...result.undo.restored, ...undo.restored].sort() } : undo,
        };
      }
      return result;
    },
    removeForChat: async (chatId) => {
      state.delete(chatId);
    },
  };
}
