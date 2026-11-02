// Review state per chat (plan G5.3): hunk decisions keyed by chat + revision + hunk id, the diff layout and the
// selected file. In memory only. When the proposal's revision moves on, decisions for hunk ids that still exist
// carry over; the rest are dropped.

import type { HunkDecision, Id, PendingChanges } from '@shared/types';
import { useMemo } from 'react';
import { create } from 'zustand';
import { buildDecisions, type Decisions } from './diff';

export type DiffMode = 'unified' | 'split';

interface ChatReview {
  /** The revision `decisions` were made against. */
  revision: number;
  decisions: Decisions;
  mode: DiffMode;
  current: string | null;
}

const EMPTY: ChatReview = { revision: -1, decisions: {}, mode: 'unified', current: null };
const NO_DECISIONS: Decisions = {};

/** The entry's decisions valid for `pending` (same revision: as is; another: pruned to existing hunk ids). */
export function effectiveDecisions(entry: ChatReview | undefined, pending: PendingChanges | null): Decisions {
  if (!entry || !pending) return NO_DECISIONS;
  return entry.revision === pending.revision ? entry.decisions : buildDecisions(pending.files, entry.decisions);
}

interface ReviewStore {
  chats: Record<Id, ChatReview>;
  decide(chatId: Id, pending: PendingChanges, path: string, hunkId: string, decision: HunkDecision | null): void;
  /** Accept all / Reject all. */
  setAll(chatId: Id, pending: PendingChanges, decision: HunkDecision): void;
  setMode(chatId: Id, mode: DiffMode): void;
  setCurrent(chatId: Id, path: string | null): void;
  clearDecisions(chatId: Id): void;
}

export const useReviewStore = create<ReviewStore>()((set) => {
  const update = (chatId: Id, f: (c: ChatReview) => Partial<ChatReview>) =>
    set((s) => {
      const cur = s.chats[chatId] ?? EMPTY;
      return { chats: { ...s.chats, [chatId]: { ...cur, ...f(cur) } } };
    });
  return {
    chats: {},
    decide: (chatId, pending, path, hunkId, decision) =>
      update(chatId, (c) => {
        const decisions: Decisions = { ...effectiveDecisions(c, pending) };
        const file = { ...decisions[path] };
        if (decision) file[hunkId] = decision;
        else delete file[hunkId];
        decisions[path] = file;
        return { revision: pending.revision, decisions };
      }),
    setAll: (chatId, pending, decision) =>
      update(chatId, () => {
        const decisions: Decisions = {};
        for (const f of pending.files) {
          if (f.hunks.length > 0) decisions[f.path] = Object.fromEntries(f.hunks.map((h) => [h.id, decision]));
        }
        return { revision: pending.revision, decisions };
      }),
    setMode: (chatId, mode) => update(chatId, () => ({ mode })),
    setCurrent: (chatId, current) => update(chatId, () => ({ current })),
    clearDecisions: (chatId) => update(chatId, () => ({ revision: -1, decisions: {} })),
  };
});

export function useDecisions(chatId: Id, pending: PendingChanges | null): Decisions {
  const entry = useReviewStore((s) => s.chats[chatId]);
  return useMemo(() => effectiveDecisions(entry, pending), [entry, pending]);
}

export function useReviewView(chatId: Id): { mode: DiffMode; current: string | null } {
  const mode = useReviewStore((s) => s.chats[chatId]?.mode ?? 'unified');
  const current = useReviewStore((s) => s.chats[chatId]?.current ?? null);
  return { mode, current };
}
