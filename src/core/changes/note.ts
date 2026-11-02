// The `changesNote` wording (v0.2 plan §4.9). All review-mode phrasing lives here so auto mode can swap it.

import { APP_NAME } from '@shared/constants';
import type { ApplyConflictReason, ChangeKind } from '@shared/types';

export interface NoteFile {
  path: string;
  kind: ChangeKind;
  accepted: number;
  total: number;
}

export type ChangeEvent =
  | {
      type: 'applied';
      written: NoteFile[];
      rejected: NoteFile[];
      /** Files with no decision at all. */
      skipped: NoteFile[];
      conflicts: { path: string; reason: ApplyConflictReason }[];
    }
  | { type: 'discarded'; files: { path: string; kind: ChangeKind }[] };

const CONFLICT_TEXT: Record<ApplyConflictReason, string> = {
  changed_on_disk: 'changed on disk before apply',
  deleted_on_disk: 'deleted on disk before apply',
  exists_on_disk: 'already exists on disk',
  blocked: 'blocked, the path is not writable',
};

const notDone: Record<ChangeKind, string> = {
  create: 'new file, not created',
  modify: 'not changed',
  delete: 'not deleted',
};

const writtenText = (f: NoteFile): string => `${f.path} (${f.accepted} of ${f.total}${f.total > 1 ? ' changes' : ''})`;

/** Returns the note for the given events, or undefined when there is nothing to report. */
export function buildNote(events: ChangeEvent[], stillPending: number): string | undefined {
  if (events.length === 0) return undefined;
  const written: string[] = [];
  const rejected: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  const discarded: string[] = [];
  for (const e of events) {
    if (e.type === 'discarded') {
      discarded.push(...e.files.map((f) => `${f.path} (${notDone[f.kind]})`));
      continue;
    }
    written.push(...e.written.map(writtenText));
    rejected.push(...e.rejected.map((f) => `${f.path} (${notDone[f.kind]})`));
    skipped.push(...e.skipped.map((f) => `${f.path} (${notDone[f.kind]})`));
    conflicts.push(...e.conflicts.map((c) => `${c.path} (${CONFLICT_TEXT[c.reason]})`));
  }
  const lines = [`[${APP_NAME}] Since your last reply the user reviewed your proposed edits:`];
  if (written.length) lines.push(`- Written: ${written.join(', ')}`);
  if (rejected.length) lines.push(`- Rejected: ${rejected.join(', ')}`);
  if (discarded.length) lines.push(`- Discarded: ${discarded.join(', ')}`);
  if (skipped.length) lines.push(`- Left out, not decided: ${skipped.join(', ')}`);
  for (const c of conflicts) lines.push(`- Not written, ${c.replace(/^(.*) \((.*)\)$/, '$2: $1')}`);
  lines.push(
    stillPending > 0
      ? `${stillPending} proposed file${stillPending === 1 ? ' is' : 's are'} still awaiting review. Your reads show your proposed versions.`
      : 'Nothing else is pending.',
  );
  return lines.join('\n');
}
