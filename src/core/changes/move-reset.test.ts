// A chat's project change resets its per-project Auto state (open batches closed, read records cleared), and
// everything per-project is keyed by project anyway: batches, read records, the proposal overlay and Undo. A failed
// save of the change history never hides a write that reached the disk. The final bytes, CRLF included, are capped.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CHAT_HAS_NO_PROJECT } from '@shared/api';
import { LIMITS } from '@shared/constants';
import type { EditMode } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { autoUnreadText, autoWriteFailedText, PROPOSED_VERSION_NOTE, writtenTooLargeText } from '../agent/edit-mode';
import { ensureDataDir } from '../storage/paths';
import { cleanupTempDirs, makeTempDir } from '../storage/test-helpers';
import { createReadFileTool } from '../tools/read-file';
import type { EditToolName } from '../tools/types';
import { tempVolumeIgnoresCase, type WriteHookInfo } from './auto-test-helpers';
import { sha256 } from './blobs';
import { createChangesService } from './index';

cleanupTempDirs();

const CHAT = 'chat1';
const R = '// created by the fake provider\n';

async function setup() {
  const base = await makeTempDir();
  const roots: Record<'A' | 'B', string> = { A: '', B: '' };
  for (const name of ['A', 'B'] as const) {
    await fs.mkdir(path.join(base, name));
    roots[name] = await fs.realpath(path.join(base, name));
  }
  const dataDir = (await ensureDataDir(path.join(base, 'data'))).root;
  const state = { current: 'A' as string | null };
  const hooks: {
    beforeWrite?: (info: WriteHookInfo) => Promise<void> | void;
    beforeStoreWrite?: () => Promise<void> | void;
  } = {};
  const make = () =>
    createChangesService({
      dataDir,
      chatProjectId: async () => state.current,
      beforeWrite: (info) => hooks.beforeWrite?.(info),
      beforeStoreWrite: () => hooks.beforeStoreWrite?.(),
    });
  const svc = make();
  const tools = (project: 'A' | 'B', o: { turnId?: string; mode?: EditMode; chatId?: string } = {}) =>
    svc.tools({
      chatId: o.chatId ?? CHAT,
      projectId: project,
      projectRoot: roots[project],
      messageId: 'm1',
      turnId: o.turnId ?? 'u',
      mode: o.mode ?? 'auto',
    });
  const abs = (project: 'A' | 'B', rel: string) => path.join(roots[project], rel);
  const seed = (project: 'A' | 'B', rel: string, data: string) => fs.writeFile(abs(project, rel), data);
  const read = (project: 'A' | 'B', rel: string) => fs.readFile(abs(project, rel), 'utf8');
  const exists = (project: 'A' | 'B', rel: string) =>
    fs.lstat(abs(project, rel)).then(
      () => true,
      () => false,
    );
  const hashNow = async (project: 'A' | 'B', rel: string) => {
    try {
      return sha256(await fs.readFile(abs(project, rel)));
    } catch {
      return '';
    }
  };
  /** A tool call that built its change from the file as it is on disk right now. */
  const put = async (
    project: 'A' | 'B',
    rel: string,
    content: string | null,
    o: { turnId?: string; tool?: EditToolName } = {},
  ) => tools(project, o).write(rel, content, { tool: o.tool ?? 'write_file', baseHash: await hashNow(project, rel) });
  /** What `read_file` does: records what this chat saw, under the turn's project. */
  const noteRead = async (project: 'A' | 'B', rel: string, o: { turnId?: string } = {}) =>
    tools(project, o).noteRead(rel, await fs.readFile(abs(project, rel)));
  /** A move as the routes make it: the chat's project changes inside `changeProject`. */
  const moveTo = (to: string | null, chatId = CHAT) =>
    svc.changeProject(chatId, async () => {
      state.current = to;
    });
  const undo = (project: 'A' | 'B', batchId: string) =>
    svc.undoBatch({ chatId: CHAT, projectId: project, projectRoot: roots[project], batchId });
  const storeFile = (chatId = CHAT) => path.join(dataDir, 'changes', `${chatId}.json`);
  const stored = async () => JSON.parse(await fs.readFile(storeFile(), 'utf8'));
  const blobs = async () => (await fs.readdir(path.join(dataDir, 'changes', `${CHAT}.blobs`)).catch(() => [])).sort();
  return {
    svc,
    make,
    hooks,
    state,
    roots,
    tools,
    seed,
    read,
    exists,
    put,
    noteRead,
    abs,
    moveTo,
    undo,
    storeFile,
    stored,
    blobs,
  };
}

describe('batches stay in their project', () => {
  it('the same turn writing in B (a detach that skipped the reset) opens its own batch; Undo in A leaves B alone', async () => {
    const s = await setup();
    await s.seed('A', 'result.txt', R);
    await s.put('A', 'first.txt', 'first\n');
    // No `changeProject`: as when `projects.remove` detaches a chat that joined after the route listed its chats.
    await s.put('B', 'result.txt', R);
    const applied = (await s.svc.get(CHAT)).applied;
    expect(applied).toHaveLength(2);
    expect((await s.stored()).applied.map((b: { projectId: string }) => b.projectId)).toEqual(['A', 'B']);
    expect(applied.map((b) => b.written.map((f) => f.path))).toEqual([['first.txt'], ['result.txt']]);

    const done = await s.undo('A', applied[0]?.id ?? '');
    expect(done.batch.undo?.restored).toEqual(['first.txt']);
    expect(await s.exists('A', 'first.txt')).toBe(false);
    expect(await s.read('A', 'result.txt')).toBe(R);
    expect(await s.read('B', 'result.txt')).toBe(R);
  });

  it('a move closes the open batch: the same in-flight turn’s next write in A opens a new one', async () => {
    const s = await setup();
    await s.put('A', 'x.txt', 'x\n');
    await s.moveTo('B');
    await s.put('A', 'y.txt', 'y\n');
    const stored = (await s.stored()).applied;
    expect(stored.map((b: { projectId: string }) => b.projectId)).toEqual(['A', 'A']);
    expect(stored[0]).toMatchObject({ closed: true });
    expect(stored[1]).not.toHaveProperty('closed');
    expect((await s.svc.get(CHAT)).applied.map((b) => b.written.map((f) => f.path))).toEqual([['x.txt'], ['y.txt']]);
    // `closed` is never sent.
    expect((await s.svc.get(CHAT)).applied[0]).not.toHaveProperty('closed');
  });

  it('a no-op move resets nothing: the next write joins the batch and a read still counts', async () => {
    const s = await setup();
    await s.seed('A', 'read.txt', 'before\n');
    await s.put('A', 'x.txt', 'x\n');
    await s.noteRead('A', 'read.txt');
    await s.moveTo('A');
    await s.put('A', 'y.txt', 'y\n');
    await s.put('A', 'read.txt', 'after\n'); // `write_file` over a file read before the no-op move
    const applied = (await s.svc.get(CHAT)).applied;
    expect(applied).toHaveLength(1);
    expect(applied[0]?.written.map((f) => f.path)).toEqual(['read.txt', 'x.txt', 'y.txt']);
    expect(await s.stored()).not.toHaveProperty('applied.0.closed');
    // A chat without change history gets no store file from a move.
    s.state.current = 'A';
    await s.svc.changeProject('other', async () => {
      s.state.current = 'B';
    });
    await expect(fs.access(s.storeFile('other'))).rejects.toThrow();
  });

  it('a refused move resets nothing', async () => {
    const s = await setup();
    await s.seed('A', 'read.txt', 'before\n');
    await s.put('A', 'x.txt', 'x\n');
    await s.noteRead('A', 'read.txt');
    const before = await s.stored();
    await expect(
      s.svc.changeProject(CHAT, async () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect(await s.stored()).toEqual(before);
    await s.put('A', 'read.txt', 'after\n');
    expect((await s.svc.get(CHAT)).applied).toHaveLength(1);
  });
});

describe('read records stay in their project', () => {
  it('a read in A never lets a write or delete through in B, even for the same bytes at the same path', async () => {
    const s = await setup();
    await s.seed('A', 'x.txt', 'same\n');
    await s.seed('B', 'x.txt', 'same\n');
    await s.noteRead('A', 'x.txt');
    for (const [content, tool] of [
      ['new\n', 'write_file'],
      [null, 'delete_file'],
    ] as const) {
      await expect(s.put('B', 'x.txt', content, { tool })).rejects.toMatchObject({
        code: 'conflict',
        message: autoUnreadText('x.txt'),
      });
    }
    expect(await s.read('B', 'x.txt')).toBe('same\n');
  });

  it('a late read of the in-flight turn after a move is recorded in A only', async () => {
    const s = await setup();
    await s.seed('A', 'x.txt', 'same\n');
    await s.seed('B', 'x.txt', 'same\n');
    await s.moveTo('B');
    await s.noteRead('A', 'x.txt'); // the loop commits the old turn's read after the move
    await expect(s.put('B', 'x.txt', 'new\n')).rejects.toMatchObject({ message: autoUnreadText('x.txt') });
    expect(await s.read('B', 'x.txt')).toBe('same\n');
  });

  it('a move clears the reads: the in-flight turn must read again before overwriting in A', async () => {
    const s = await setup();
    await s.seed('A', 'x.txt', 'old\n');
    await s.noteRead('A', 'x.txt');
    await s.moveTo('B');
    await expect(s.put('A', 'x.txt', 'new\n')).rejects.toMatchObject({ message: autoUnreadText('x.txt') });
    expect(await s.read('A', 'x.txt')).toBe('old\n');
  });
});

describe('a write is never hidden by a failed save of the change history', () => {
  it('a failed save after the write: resolved with `unsaved`, kept in memory, saved by the next store operation', async () => {
    const s = await setup();
    let fail = false;
    s.hooks.beforeWrite = () => {
      fail = true;
    };
    s.hooks.beforeStoreWrite = () => {
      if (!fail) return;
      fail = false;
      throw new Error('disk full');
    };
    const result = await s.put('A', 'n.txt', 'hi\n');
    expect(result).toMatchObject({ file: { kind: 'create' }, unsaved: true });
    expect(result.batchId).toEqual(expect.any(String));
    expect(await s.read('A', 'n.txt')).toBe('hi\n');
    const live = await s.svc.get(CHAT);
    expect(live.applied.map((b) => b.id)).toEqual([result.batchId]);
    expect(live.diskSeq).toBe(1);
    // Not on disk yet: a fresh service (another process) sees no batch.
    expect((await s.make().get(CHAT)).applied).toEqual([]);

    s.hooks.beforeWrite = undefined;
    await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false });
    expect((await s.make().get(CHAT)).applied.map((b) => b.id)).toEqual([result.batchId]);
    await s.undo('A', result.batchId ?? '');
    expect(await s.exists('A', 'n.txt')).toBe(false);
  });

  it('while the unsaved history still can’t be saved, the next write is refused before it touches the file', async () => {
    const s = await setup();
    let failing = false;
    s.hooks.beforeWrite = () => {
      failing = true;
    };
    s.hooks.beforeStoreWrite = () => {
      if (failing) throw new Error('disk full');
    };
    expect(await s.put('A', 'n.txt', 'hi\n')).toMatchObject({ unsaved: true });
    s.hooks.beforeWrite = undefined;
    await expect(s.put('A', 'm.txt', 'm\n')).rejects.toMatchObject({
      code: 'internal',
      message: autoWriteFailedText('m.txt'),
    });
    expect(await s.exists('A', 'm.txt')).toBe(false);
  });

  it('Undo is refused (internal) and restores nothing while the unsaved history can’t be saved', async () => {
    const s = await setup();
    let failing = false;
    s.hooks.beforeWrite = () => {
      failing = true;
    };
    s.hooks.beforeStoreWrite = () => {
      if (failing) throw new Error('disk full');
    };
    const { batchId } = await s.put('A', 'n.txt', 'hi\n');
    s.hooks.beforeWrite = undefined;
    await expect(s.undo('A', batchId ?? '')).rejects.toMatchObject({ code: 'internal' });
    expect(await s.read('A', 'n.txt')).toBe('hi\n');
  });
});

describe('stored originals outlive the saved history that references them', () => {
  it('a write that drops the oldest batch from retention but can’t be saved keeps its original for the saved history', async () => {
    const s = await setup();
    // Batch 1 modifies old.txt, so its Undo needs the stored original.
    await s.seed('A', 'old.txt', 'the original, unique bytes\n');
    await s.noteRead('A', 'old.txt', { turnId: 't0' });
    const first = await s.put('A', 'old.txt', 'changed\n', { turnId: 't0' });
    // Batches 2–20 fill the retention window.
    for (let i = 1; i < LIMITS.autoUndoTurns; i++) await s.put('A', `f${i}.txt`, `${i}\n`, { turnId: `t${i}` });
    expect((await s.blobs()).length).toBe(1);

    // Batch 21 reaches the disk, but its history can't be saved.
    let fail = false;
    s.hooks.beforeWrite = () => {
      fail = true;
    };
    s.hooks.beforeStoreWrite = () => {
      if (!fail) return;
      fail = false;
      throw new Error('disk full');
    };
    expect(await s.put('A', 'last.txt', 'last\n', { turnId: 'tlast' })).toMatchObject({ unsaved: true });
    s.hooks.beforeWrite = undefined;
    expect((await s.blobs()).length).toBe(1);

    // A fresh service (a restart) reads the last saved history: batch 1 is still undoable, and its original is there.
    const fresh = s.make();
    const saved = await fresh.get(CHAT);
    expect(saved.applied.find((b) => b.id === first.batchId)?.undoable).toBe(true);
    const undone = await fresh.undoBatch({
      chatId: CHAT,
      projectId: 'A',
      projectRoot: s.roots.A,
      batchId: first.batchId ?? '',
    });
    expect(undone.batch.undo).toMatchObject({ restored: ['old.txt'], skipped: [] });
    expect(await s.read('A', 'old.txt')).toBe('the original, unique bytes\n');
  });

  it('once a history without the batch is saved, its original is collected', async () => {
    const s = await setup();
    await s.seed('A', 'old.txt', 'the original\n');
    await s.noteRead('A', 'old.txt', { turnId: 't0' });
    await s.put('A', 'old.txt', 'changed\n', { turnId: 't0' });
    for (let i = 1; i < LIMITS.autoUndoTurns; i++) await s.put('A', `f${i}.txt`, `${i}\n`, { turnId: `t${i}` });
    let fail = false;
    s.hooks.beforeWrite = () => {
      fail = true;
    };
    s.hooks.beforeStoreWrite = () => {
      if (!fail) return;
      fail = false;
      throw new Error('disk full');
    };
    await s.put('A', 'last.txt', 'last\n', { turnId: 'tlast' });
    s.hooks.beforeWrite = undefined;
    expect((await s.blobs()).length).toBe(1);
    // The next file operation saves the history first, then collects.
    await s.put('A', 'next.txt', 'next\n', { turnId: 'tnext' });
    expect(await s.blobs()).toEqual([]);
  });
});

describe('Undo reads the chat’s project under the store lock', () => {
  it('the caller read A, the chat is in B (or has none): refused, nothing restored', async () => {
    const s = await setup();
    const { batchId } = await s.put('A', 'n.txt', 'hi\n');
    s.state.current = 'B';
    await expect(s.undo('A', batchId ?? '')).rejects.toMatchObject({
      code: 'conflict',
      message: 'These edits can no longer be undone.',
    });
    s.state.current = null;
    await expect(s.undo('A', batchId ?? '')).rejects.toMatchObject({
      code: 'conflict',
      message: CHAT_HAS_NO_PROJECT,
    });
    expect(await s.read('A', 'n.txt')).toBe('hi\n');
    expect((await s.svc.get(CHAT)).applied[0]).not.toHaveProperty('undo');
  });
});

describe('proposals are read through only by a turn in their project', () => {
  it('a turn in B sees B’s disk, not A’s proposals; a turn in A still does', async () => {
    const s = await setup();
    await s.seed('A', 'p.txt', 'on disk in A\n');
    await s.seed('B', 'p.txt', 'on disk in B\n');
    await s.tools('A', { mode: 'review' }).stage('p.txt', 'proposed\n');
    s.state.current = 'B';
    expect(await s.tools('B').read('p.txt')).toBeNull();
    expect(await s.tools('B').staged()).toEqual([]);
    const tool = createReadFileTool();
    const signal = new AbortController().signal;
    const inB = await tool.run({ path: 'p.txt' }, { signal, projectRoot: s.roots.B, changes: s.tools('B') });
    expect(inB.ok).toBe(true);
    expect(inB.output).toContain('on disk in B');
    expect(inB.output).not.toContain(PROPOSED_VERSION_NOTE);
    expect(await s.tools('A').read('p.txt')).toEqual({ kind: 'staged', content: 'proposed\n' });
    expect(await s.tools('A').staged()).toEqual([{ path: 'p.txt', kind: 'modify' }]);
  });
});

describe('the final bytes, CRLF line endings included, must fit the write limit', () => {
  // 258,000 bytes as sent (under the limit), 266,600 once the CRLF file's line endings are kept (over it).
  const content = `${'x'.repeat(29)}\n`.repeat(8600);
  const size = content.length + 8600;

  it('Auto: refused before the blob, the folders or the mutation; nothing recorded', async () => {
    expect(content.length).toBeLessThanOrEqual(LIMITS.writeFileMaxBytes);
    expect(size).toBeGreaterThan(LIMITS.writeFileMaxBytes);
    const s = await setup();
    await s.seed('A', 'crlf.txt', 'one\r\ntwo\r\n');
    await s.noteRead('A', 'crlf.txt');
    await expect(s.put('A', 'crlf.txt', content)).rejects.toMatchObject({
      code: 'file_too_large',
      message: writtenTooLargeText('auto', 'crlf.txt', size),
    });
    expect(await s.read('A', 'crlf.txt')).toBe('one\r\ntwo\r\n');
    expect((await s.svc.get(CHAT)).applied).toEqual([]);
    expect(await s.blobs()).toEqual([]);
  });

  it('Review: the proposal is refused and the pending set is unchanged', async () => {
    const s = await setup();
    await s.seed('A', 'crlf.txt', 'one\r\ntwo\r\n');
    const review = s.tools('A', { mode: 'review' });
    await review.stage('other.txt', 'other\n');
    const before = await s.stored();
    await expect(review.stage('crlf.txt', content)).rejects.toMatchObject({
      code: 'file_too_large',
      message: writtenTooLargeText('review', 'crlf.txt', size),
    });
    expect(await s.stored()).toEqual(before);
  });
});

// SPELLINGS OF ONE FILE ARE UNDONE TOGETHER OR NOT AT ALL, across all the batches a Retry undoes: a turn split by a
// project change (refused by the routes while a turn runs; made below them here) can hold one file under one spelling
// in its older batch and under another in its newer one.
describe('a Retry over batches that hold two spellings of one file', () => {
  it('skips both spellings (blocked) in every batch, so the user’s file survives', async (ctx) => {
    ctx.skip(
      !tempVolumeIgnoresCase(),
      'needs a case-insensitive temp volume, where overlap.txt and OVERLAP.txt are one file',
    );
    const s = await setup();
    const R1 = 'first write\n';
    await s.put('A', 'overlap.txt', R1);
    // The turn's open batch is closed by a project change and back; the turn, pinned to A, writes on.
    await s.moveTo('B');
    await s.moveTo('A');
    await fs.rename(s.abs('A', 'overlap.txt'), s.abs('A', 'OVERLAP.txt'));
    await s.noteRead('A', 'OVERLAP.txt');
    await s.put('A', 'OVERLAP.txt', 'second write\n');
    expect((await s.svc.get(CHAT)).applied.map((b) => b.written.map((f) => f.path))).toEqual([
      ['overlap.txt'],
      ['OVERLAP.txt'],
    ]);
    // The user renames it back and puts back the first write's bytes, which the older batch's entry would match.
    await fs.rename(s.abs('A', 'OVERLAP.txt'), s.abs('A', 'overlap.txt'));
    await fs.writeFile(s.abs('A', 'overlap.txt'), R1);

    const res = await s.svc.prepareRetry({
      chatId: CHAT,
      projectId: 'A',
      projectRoot: s.roots.A,
      turnId: 'u',
      mode: 'auto',
    });
    expect(res?.undo).toMatchObject({
      restored: [],
      skipped: [
        { path: 'OVERLAP.txt', reason: 'blocked' },
        { path: 'overlap.txt', reason: 'blocked' },
      ],
    });
    expect(await s.read('A', 'overlap.txt')).toBe(R1);
    const undos = (await s.svc.get(CHAT)).applied.map((b) => b.undo);
    expect(undos).toEqual([
      expect.objectContaining({ restored: [], skipped: [{ path: 'overlap.txt', reason: 'blocked' }] }),
      expect.objectContaining({ restored: [], skipped: [{ path: 'OVERLAP.txt', reason: 'blocked' }] }),
    ]);
  });
});
