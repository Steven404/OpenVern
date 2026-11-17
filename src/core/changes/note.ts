// Aggregates the review events recorded since the last note. The wording lives in `agent/edit-mode.ts`.

import type { ApplyConflictReason, ChangeKind } from '@shared/types';
import { type NoteFile, type ReviewNoteInput, reviewNote } from '../agent/edit-mode';

export type { NoteFile } from '../agent/edit-mode';

export type ChangeEvent =
  | {
      type: 'applied';
      written: NoteFile[];
      rejected: NoteFile[];
      /** Files with no decision at all. */
      skipped: NoteFile[];
      conflicts: { path: string; reason: ApplyConflictReason }[];
      /** Legacy proposals too large to review, left unwritten. Missing in events recorded before it existed. */
      tooLarge?: string[];
    }
  | { type: 'discarded'; files: { path: string; kind: ChangeKind }[] };

/** Merges the events in order. */
export function aggregateEvents(events: readonly ChangeEvent[]): ReviewNoteInput {
  const out: ReviewNoteInput = { written: [], rejected: [], discarded: [], skipped: [], conflicts: [], tooLarge: [] };
  for (const e of events) {
    if (e.type === 'discarded') {
      out.discarded.push(...e.files);
      continue;
    }
    out.written.push(...e.written);
    out.rejected.push(...e.rejected);
    out.skipped.push(...e.skipped);
    out.conflicts.push(...e.conflicts);
    out.tooLarge.push(...(e.tooLarge ?? []));
  }
  return out;
}

/** Returns the review block for the given events, or undefined when there is nothing to report. */
export function buildNote(events: readonly ChangeEvent[], stillPending: number): string | undefined {
  if (events.length === 0) return undefined;
  return reviewNote(aggregateEvents(events), stillPending);
}
