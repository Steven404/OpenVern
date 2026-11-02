// Test helper: an in-memory `ChangesService` / `ToolChanges` (plan G2). It stands in for G1's real change sets. It
// keeps a per-chat pending map, captures the base from the disk on first touch and builds `FileChange`s with jsdiff,
// but never writes to the disk and does not implement apply/discard/notes beyond what the agent loop needs.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApplyChangesResponse } from '@shared/api';
import type { ChangeKind, ChangeSummary, ChatChanges, FileChange, Id } from '@shared/types';
import { structuredPatch } from 'diff';
import type { ChangesService } from '../types';
import type { ToolChanges } from './types';

interface Entry {
  kind: ChangeKind;
  base: string | null;
  content: string | null;
}

export interface FakeChangesService extends ChangesService {
  /** Pending entries per chat, for assertions. */
  readonly pending: Map<Id, Map<string, Entry>>;
  /** Calls made to the lifecycle methods, in order. */
  readonly log: string[];
  /** The text `takeNote` returns once (then undefined). */
  nextNote: string | undefined;
}

function toFileChange(rel: string, e: Entry): FileChange {
  const patch = structuredPatch(rel, rel, e.base ?? '', e.content ?? '', undefined, undefined, { context: 3 });
  let add = 0;
  let del = 0;
  const hunks = patch.hunks.map((h) => {
    for (const l of h.lines) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
    return {
      id: `${h.oldStart}:${rel.length}`,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      header: '',
      lines: h.lines,
    };
  });
  return { path: rel, kind: e.kind, add, del, hunks };
}

export function createFakeChangesService(): FakeChangesService {
  const pending = new Map<Id, Map<string, Entry>>();
  const snapshots = new Map<string, Map<string, Entry>>();
  const log: string[] = [];
  let revision = 0;

  const forChat = (chatId: Id) => {
    let m = pending.get(chatId);
    if (!m) {
      m = new Map();
      pending.set(chatId, m);
    }
    return m;
  };
  const summaryOf = (map: Map<string, Entry>, messageId: Id): ChangeSummary | null => {
    if (map.size === 0) return null;
    const files = [...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, e]) => toFileChange(p, e));
    return {
      revision,
      messageId,
      files: files.map((f) => ({ path: f.path, kind: f.kind, add: f.add, del: f.del })),
      totalAdd: files.reduce((n, f) => n + f.add, 0),
      totalDel: files.reduce((n, f) => n + f.del, 0),
    };
  };
  const clone = (m: Map<string, Entry>) => new Map([...m].map(([k, v]) => [k, { ...v }]));

  const service: FakeChangesService = {
    pending,
    log,
    nextNote: undefined,
    async get(chatId): Promise<ChatChanges> {
      const map = forChat(chatId);
      return {
        pending: map.size
          ? {
              ...(summaryOf(map, '') as ChangeSummary),
              files: [...map].map(([p, e]) => toFileChange(p, e)),
            }
          : null,
        applied: [],
      };
    },
    tools({ chatId, projectRoot, messageId }): ToolChanges {
      const map = forChat(chatId);
      return {
        async read(rel) {
          const e = map.get(rel);
          if (!e) return null;
          return e.content === null ? { kind: 'deleted' } : { kind: 'staged', content: e.content };
        },
        async staged() {
          return [...map].map(([p, e]) => ({ path: p, kind: e.kind }));
        },
        async stage(rel, content) {
          let e = map.get(rel);
          if (!e) {
            const base = await readFile(path.join(projectRoot, rel), 'utf8').catch(() => null);
            e = { kind: base === null ? 'create' : 'modify', base, content };
          }
          e.content = content;
          if (content === null) e.kind = e.base === null ? 'create' : 'delete';
          else e.kind = e.base === null ? 'create' : 'modify';
          if (e.base === null && content === null) map.delete(rel);
          else if (e.base === content) map.delete(rel);
          else map.set(rel, e);
          revision++;
          const file = map.has(rel) ? toFileChange(rel, e) : null;
          return { file, summary: summaryOf(map, messageId) };
        },
      };
    },
    async snapshot(chatId, userMessageId) {
      log.push(`snapshot:${userMessageId}`);
      snapshots.set(`${chatId}:${userMessageId}`, clone(forChat(chatId)));
    },
    async restore(chatId, userMessageId) {
      log.push(`restore:${userMessageId}`);
      pending.set(chatId, clone(snapshots.get(`${chatId}:${userMessageId}`) ?? new Map()));
    },
    async takeNote() {
      log.push('takeNote');
      const note = service.nextNote;
      service.nextNote = undefined;
      return note;
    },
    async apply(): Promise<ApplyChangesResponse> {
      throw new Error('not implemented in the fake');
    },
    async discard(chatId) {
      forChat(chatId).clear();
      return { pending: null, applied: [] };
    },
    async removeForChat(chatId) {
      pending.delete(chatId);
    },
  };
  return service;
}
