// Undo of an Auto turn (`undoBatch`) and `prepareRetry`: only files still exactly as the turn left them are restored,
// the rest are reported. Real temp project folder, real data dir; races are driven by the `beforeWrite` hook.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoUnreadText, modeChangedNote } from '../agent/edit-mode';
import { cleanupTempDirs } from '../storage/test-helpers';
import { makeFifo, releaseFifo, setupAuto, swapProjectRoot, watchFileReads, within } from './auto-test-helpers';
import { sha256 } from './blobs';

cleanupTempDirs();

const CONFLICT_MESSAGE = 'These edits can no longer be undone.';

describe('undoBatch: restoring', () => {
  it('restores modify, create and delete exactly (bytes and mode) and leaves created folders', async () => {
    const s = await setupAuto();
    await s.seed('mod.sh', '#!/bin/sh\necho old\n', 0o755);
    await s.seed('del/gone.txt', 'goner\n', 0o640);
    await s.seed('odd.txt', 'odd\n', 0o664);
    const tc = s.turn();
    await s.readPut(tc, 'mod.sh', '#!/bin/sh\necho new\n');
    await s.readPut(tc, 'del/gone.txt', null, 'delete_file');
    await s.readPut(tc, 'odd.txt', 'odd2\n');
    await s.put(tc, 'made/deep/new.txt', 'created\n');
    const before = await s.get();
    const id = before.applied[0]?.id as string;

    const res = await s.undo(id);
    expect(await s.read('mod.sh')).toBe('#!/bin/sh\necho old\n');
    expect(await s.modeOf('mod.sh')).toBe(0o755);
    expect(await s.read('del/gone.txt')).toBe('goner\n');
    expect(await s.modeOf('del/gone.txt')).toBe(0o640);
    expect(await s.read('odd.txt')).toBe('odd\n');
    expect(await s.modeOf('odd.txt')).toBe(0o664);
    expect(await s.exists('made/deep/new.txt')).toBe(false);
    expect((await fs.stat(s.abs('made/deep'))).isDirectory()).toBe(true); // folders the turn created stay

    expect(res.batch.undo).toMatchObject({
      by: 'user',
      restored: ['del/gone.txt', 'made/deep/new.txt', 'mod.sh', 'odd.txt'],
      skipped: [],
    });
    expect(Date.parse(res.batch.undo?.at ?? '')).not.toBeNaN();
    expect(res.batch.undoable).toBe(false);
    expect(res.batch.id).toBe(id);
    expect(res.changes.applied.map((b) => [b.id, b.undoable])).toEqual([[id, false]]);
    expect(res.changes.diskSeq).toBe(before.diskSeq + 1);
    expect(res.batch).not.toHaveProperty('undoData');
    expect(await s.blobs()).toEqual([]); // originals no longer needed
    // The batch keeps its audit trail.
    expect(res.batch.written.map((f) => f.path)).toEqual(before.applied[0]?.written.map((f) => f.path));
  });

  it('a file written twice in the turn goes back to its original', async () => {
    const s = await setupAuto();
    await s.seed('f.txt', 'orig\n', 0o600);
    const tc = s.turn();
    await s.readPut(tc, 'f.txt', 'one\n');
    await s.put(tc, 'f.txt', 'two\n');
    await s.undo((await s.get()).applied[0]?.id as string);
    expect(await s.read('f.txt')).toBe('orig\n');
    expect(await s.modeOf('f.txt')).toBe(0o600);
  });

  it('a file deleted, then recreated by the model in the same turn, is restored to the original', async () => {
    const s = await setupAuto();
    await s.seed('f.txt', 'orig\n');
    const tc = s.turn();
    await s.readPut(tc, 'f.txt', null, 'delete_file');
    await s.put(tc, 'f.txt', 'reborn\n');
    await s.undo((await s.get()).applied[0]?.id as string);
    expect(await s.read('f.txt')).toBe('orig\n');
  });

  it('records the batch as undone: undoable false, a second undo is a conflict, nothing changes', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'orig\n');
    await s.readPut(s.turn(), 'a.txt', 'new\n');
    const id = (await s.get()).applied[0]?.id as string;
    await s.undo(id);
    await fs.writeFile(s.abs('a.txt'), 'later work\n');
    const seq = (await s.get()).diskSeq;
    await expect(s.undo(id)).rejects.toMatchObject({ code: 'conflict', message: CONFLICT_MESSAGE });
    expect(await s.read('a.txt')).toBe('later work\n');
    const after = await s.get();
    expect(after.diskSeq).toBe(seq);
    expect(after.applied[0]).toMatchObject({ undoable: false, undo: { by: 'user', restored: ['a.txt'] } });
    // Persisted: a new service instance over the same data dir sees the same.
    const stored = await s.readStore();
    expect(stored.applied[0].undo.restored).toEqual(['a.txt']);
    expect(stored.applied[0].undoData).toBeUndefined();
  });

  it('recreates a parent folder the user removed, for a deleted file', async () => {
    const s = await setupAuto();
    await s.seed('dir/sub/x.txt', 'x\n');
    await s.readPut(s.turn(), 'dir/sub/x.txt', null, 'delete_file');
    await fs.rm(s.abs('dir'), { recursive: true });
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo?.restored).toEqual(['dir/sub/x.txt']);
    expect(await s.read('dir/sub/x.txt')).toBe('x\n');
  });

  it('removes the read record of restored paths: write_file on one needs a fresh read', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'orig\n');
    const tc = s.turn();
    await s.readPut(tc, 'a.txt', 'new\n');
    await s.undo((await s.get()).applied[0]?.id as string);
    await expect(s.put(s.turn({ turnId: 't2' }), 'a.txt', 'again\n')).rejects.toMatchObject({
      message: autoUnreadText('a.txt'),
    });
  });
});

describe('undoBatch: skipped files', () => {
  it('a file edited after the turn is skipped (changed_since); the others are restored', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a0\n');
    await s.seed('b.txt', 'b0\n');
    const tc = s.turn();
    await s.readPut(tc, 'a.txt', 'a1\n');
    await s.readPut(tc, 'b.txt', 'b1\n');
    await fs.writeFile(s.abs('a.txt'), 'a1 plus user work\n');
    const before = await s.get();
    const res = await s.undo(before.applied[0]?.id as string);
    expect(res.batch.undo).toMatchObject({
      restored: ['b.txt'],
      skipped: [{ path: 'a.txt', reason: 'changed_since' }],
    });
    expect(await s.read('a.txt')).toBe('a1 plus user work\n');
    expect(await s.read('b.txt')).toBe('b0\n');
    expect(res.changes.diskSeq).toBe(before.diskSeq + 1);
    expect(res.batch.undoable).toBe(false); // done, even though one file was left
  });

  it('a file deleted by the turn and recreated by the user is skipped, even with identical bytes', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'orig\n');
    await s.seed('b.txt', 'orig b\n');
    const tc = s.turn();
    await s.readPut(tc, 'a.txt', null, 'delete_file');
    await s.readPut(tc, 'b.txt', null, 'delete_file');
    await fs.writeFile(s.abs('a.txt'), 'the user wrote this\n');
    await fs.writeFile(s.abs('b.txt'), 'orig b\n');
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo?.restored).toEqual([]);
    expect(res.batch.undo?.skipped).toEqual([
      { path: 'a.txt', reason: 'changed_since' },
      { path: 'b.txt', reason: 'changed_since' },
    ]);
    expect(await s.read('a.txt')).toBe('the user wrote this\n');
    // Nothing restored: the disk sequence doesn't move.
    expect(res.changes.diskSeq).toBe(2);
  });

  it('a created file that the user deleted or edited is skipped, never recreated or removed', async () => {
    const s = await setupAuto();
    const tc = s.turn();
    await s.put(tc, 'gone.txt', 'made\n');
    await s.put(tc, 'edited.txt', 'made\n');
    await fs.rm(s.abs('gone.txt'));
    await fs.writeFile(s.abs('edited.txt'), 'made, then changed\n');
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo?.skipped).toEqual([
      { path: 'edited.txt', reason: 'changed_since' },
      { path: 'gone.txt', reason: 'changed_since' },
    ]);
    expect(await s.exists('gone.txt')).toBe(false);
    expect(await s.read('edited.txt')).toBe('made, then changed\n');
  });

  it('a path that became a symlink is skipped (blocked); the link and its target are untouched', async () => {
    const s = await setupAuto();
    await fs.writeFile(path.join(s.outside, 'target.txt'), 'T\n');
    await s.seed('mod.txt', 'orig\n');
    await s.seed('del.txt', 'orig del\n');
    const tc = s.turn();
    await s.readPut(tc, 'mod.txt', 'new\n');
    await s.readPut(tc, 'del.txt', null, 'delete_file');
    await s.put(tc, 'made.txt', 'made\n');
    await fs.rm(s.abs('mod.txt'));
    await fs.symlink(path.join(s.outside, 'target.txt'), s.abs('mod.txt'));
    await fs.symlink(path.join(s.outside, 'target.txt'), s.abs('del.txt'));
    await fs.rm(s.abs('made.txt'));
    await fs.symlink(path.join(s.outside, 'target.txt'), s.abs('made.txt'));
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo?.restored).toEqual([]);
    expect(res.batch.undo?.skipped).toEqual([
      { path: 'del.txt', reason: 'blocked' },
      { path: 'made.txt', reason: 'blocked' },
      { path: 'mod.txt', reason: 'blocked' },
    ]);
    expect(await fs.readFile(path.join(s.outside, 'target.txt'), 'utf8')).toBe('T\n');
    for (const f of ['mod.txt', 'del.txt', 'made.txt']) expect((await fs.lstat(s.abs(f))).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(s.outside)).toEqual(['target.txt']);
  });

  it('a parent folder that became a symlink: blocked, and nothing is written through it', async () => {
    const s = await setupAuto();
    await s.seed('dir/x.txt', 'x\n');
    await s.seed('dir/y.txt', 'y\n');
    const tc = s.turn();
    await s.readPut(tc, 'dir/x.txt', null, 'delete_file');
    await s.readPut(tc, 'dir/y.txt', 'y2\n');
    await fs.rm(s.abs('dir'), { recursive: true });
    await fs.symlink(s.outside, s.abs('dir'));
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo?.restored).toEqual([]);
    expect(res.batch.undo?.skipped.map((x) => x.reason)).toEqual(['blocked', 'blocked']);
    expect(await fs.readdir(s.outside)).toEqual([]);
  });

  it('a path swapped for a symlink between the check and the restore (hook) is not written through', async () => {
    const s = await setupAuto();
    await fs.writeFile(path.join(s.outside, 'target.txt'), 'T\n');
    await s.seed('a.txt', 'orig\n');
    await s.readPut(s.turn(), 'a.txt', 'new\n');
    s.hooks.beforeWrite = async (info) => {
      expect(info.op).toBe('undo');
      await fs.rm(s.abs('a.txt'));
      await fs.symlink(path.join(s.outside, 'target.txt'), s.abs('a.txt'));
    };
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo?.skipped).toEqual([{ path: 'a.txt', reason: 'blocked' }]);
    expect(await fs.readFile(path.join(s.outside, 'target.txt'), 'utf8')).toBe('T\n');
  });

  it('a throw while restoring is skipped (blocked) and the rest continue', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a0\n');
    await s.seed('b.txt', 'b0\n');
    const tc = s.turn();
    await s.readPut(tc, 'a.txt', 'a1\n');
    await s.readPut(tc, 'b.txt', 'b1\n');
    s.hooks.beforeWrite = (info) => {
      if (info.path === 'a.txt') throw new Error('disk on fire');
    };
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo).toMatchObject({ restored: ['b.txt'], skipped: [{ path: 'a.txt', reason: 'blocked' }] });
    expect(await s.read('a.txt')).toBe('a1\n');
    expect(await s.read('b.txt')).toBe('b0\n');
  });

  it('a missing or damaged blob is skipped (unavailable); the file is left as it is', async () => {
    const s = await setupAuto();
    await s.seed('missing.txt', 'm0\n');
    await s.seed('damaged.txt', 'd0\n');
    await s.seed('ok.txt', 'o0\n');
    const tc = s.turn();
    for (const f of ['missing', 'damaged', 'ok']) await s.readPut(tc, `${f}.txt`, `${f} new\n`);
    await fs.rm(path.join(s.blobDir(), sha256('m0\n')));
    await fs.writeFile(path.join(s.blobDir(), sha256('d0\n')), 'garbage');
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo).toMatchObject({
      restored: ['ok.txt'],
      skipped: [
        { path: 'damaged.txt', reason: 'unavailable' },
        { path: 'missing.txt', reason: 'unavailable' },
      ],
    });
    expect(await s.read('damaged.txt')).toBe('damaged new\n');
    expect(await s.read('missing.txt')).toBe('missing new\n');
    expect(await s.read('ok.txt')).toBe('o0\n');
  });

  it.skipIf(process.platform === 'win32')(
    'a FIFO in a blob’s place is skipped (unavailable) at once, not waited on; the others are restored',
    async () => {
      const s = await setupAuto();
      await s.seed('a.txt', 'a0\n');
      await s.seed('b.txt', 'b0\n');
      const tc = s.turn();
      await s.readPut(tc, 'a.txt', 'a1\n');
      await s.readPut(tc, 'b.txt', 'b1\n');
      const blob = path.join(s.blobDir(), sha256('a0\n'));
      await fs.rm(blob);
      makeFifo(blob);
      let res: Awaited<ReturnType<typeof s.undo>>;
      try {
        res = await within(2_000, s.undo((await s.get()).applied[0]?.id as string));
      } finally {
        await releaseFifo(blob);
      }
      expect(res.batch.undo).toMatchObject({
        restored: ['b.txt'],
        skipped: [{ path: 'a.txt', reason: 'unavailable' }],
      });
      expect(await s.read('a.txt')).toBe('a1\n');
      expect(await s.read('b.txt')).toBe('b0\n');
    },
  );

  it('a corrupt 6 MiB blob is skipped (unavailable) without being read in full', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a0\n');
    await s.readPut(s.turn(), 'a.txt', 'a1\n');
    await fs.writeFile(path.join(s.blobDir(), sha256('a0\n')), Buffer.alloc(6 * 1024 * 1024, 0x62));
    const reads = await watchFileReads(s.abs('a.txt'));
    let res: Awaited<ReturnType<typeof s.undo>>;
    try {
      res = await s.undo((await s.get()).applied[0]?.id as string);
      expect(reads.readFileCalls()).toBe(0);
      // Only the project file and the store are read; not one byte of the blob.
      expect(await reads.bytesRead()).toBeLessThan(64 * 1024);
    } finally {
      reads.restore();
    }
    expect(res.batch.undo?.skipped).toEqual([{ path: 'a.txt', reason: 'unavailable' }]);
    expect(await s.read('a.txt')).toBe('a1\n');
  });

  it('a blob for a file the turn deleted: missing → unavailable, and the file is not recreated empty', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'orig\n');
    await s.readPut(s.turn(), 'a.txt', null, 'delete_file');
    await fs.rm(s.blobDir(), { recursive: true });
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo?.skipped).toEqual([{ path: 'a.txt', reason: 'unavailable' }]);
    expect(await s.exists('a.txt')).toBe(false);
  });
});

describe('undoBatch: the file changes after the check (inside the hook)', () => {
  // The first check runs before the blob read, the folder creation and the hook; the restore must check again right
  // before it writes or unlinks, or it destroys what changed in between.
  it('a modified file edited inside the hook is not overwritten: skipped changed_since', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'orig\n');
    await s.seed('b.txt', 'b0\n');
    const tc = s.turn();
    await s.readPut(tc, 'a.txt', 'new\n');
    await s.readPut(tc, 'b.txt', 'b1\n');
    s.hooks.beforeWrite = async (info) => {
      if (info.path === 'a.txt') await fs.writeFile(s.abs('a.txt'), 'user edit\n');
    };
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo).toMatchObject({
      restored: ['b.txt'],
      skipped: [{ path: 'a.txt', reason: 'changed_since' }],
    });
    expect(await s.read('a.txt')).toBe('user edit\n');
    expect(await s.read('b.txt')).toBe('b0\n');
  });

  it('a deleted file recreated inside the hook is not overwritten: skipped changed_since', async () => {
    const s = await setupAuto();
    await s.seed('gone.txt', 'orig\n');
    await s.readPut(s.turn(), 'gone.txt', null, 'delete_file');
    s.hooks.beforeWrite = async () => {
      await fs.writeFile(s.abs('gone.txt'), 'recreated by the user\n');
    };
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo).toMatchObject({ restored: [], skipped: [{ path: 'gone.txt', reason: 'changed_since' }] });
    expect(await s.read('gone.txt')).toBe('recreated by the user\n');
  });

  it('a created file edited inside the hook is not removed: skipped changed_since', async () => {
    const s = await setupAuto();
    await s.put(s.turn(), 'made.txt', 'made\n');
    s.hooks.beforeWrite = async () => {
      await fs.writeFile(s.abs('made.txt'), 'user edit\n');
    };
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo).toMatchObject({ restored: [], skipped: [{ path: 'made.txt', reason: 'changed_since' }] });
    expect(await s.read('made.txt')).toBe('user edit\n');
  });
});

describe('undoBatch: the project folder swapped for a link to another folder (inside the hook)', () => {
  it('every file is blocked, the ones after the swap too; nothing outside or in the moved project changes', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a0\n');
    await s.seed('b.txt', 'b0\n');
    const tc = s.turn();
    await s.readPut(tc, 'a.txt', 'a1\n'); // modified
    await s.readPut(tc, 'b.txt', null, 'delete_file'); // deleted
    await s.readPut(tc, 'c.txt', 'c1\n'); // created
    // The other folder looks exactly like what the turn left, so every hash check would pass there.
    await fs.writeFile(path.join(s.outside, 'a.txt'), 'a1\n');
    await fs.writeFile(path.join(s.outside, 'c.txt'), 'c1\n');
    const seqBefore = (await s.get()).diskSeq;
    let moved = '';
    s.hooks.beforeWrite = async () => {
      // Only the first file reaches the hook; the others must be refused by the root pinned for the whole undo.
      if (!moved) moved = await swapProjectRoot(s);
    };
    const res = await s.undo((await s.get()).applied[0]?.id as string);
    expect(res.batch.undo).toMatchObject({
      restored: [],
      skipped: [
        { path: 'a.txt', reason: 'blocked' },
        { path: 'b.txt', reason: 'blocked' },
        { path: 'c.txt', reason: 'blocked' },
      ],
    });
    expect(res.changes.diskSeq).toBe(seqBefore);
    for (const dir of [s.outside, moved]) {
      expect((await fs.readdir(dir)).sort()).toEqual(['a.txt', 'c.txt']);
      expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('a1\n');
      expect(await fs.readFile(path.join(dir, 'c.txt'), 'utf8')).toBe('c1\n');
    }
  });
});

describe('undoBatch: ordering between turns', () => {
  async function twoTurns() {
    const s = await setupAuto();
    await s.seed('shared.txt', 's0\n');
    await s.seed('only1.txt', 'o0\n');
    await s.seed('only2.txt', 'p0\n');
    const t1 = s.turn({ turnId: 't1', messageId: 'm1' });
    await s.readPut(t1, 'shared.txt', 's1\n');
    await s.readPut(t1, 'only1.txt', 'o1\n');
    const t2 = s.turn({ turnId: 't2', messageId: 'm2' });
    await s.put(t2, 'shared.txt', 's2\n');
    await s.readPut(t2, 'only2.txt', 'p1\n');
    const [b1, b2] = (await s.get()).applied.map((b) => b.id);
    return { s, b1: b1 as string, b2: b2 as string };
  }

  it('undo the later turn, then the earlier one: both restore, down to the very original', async () => {
    const { s, b1, b2 } = await twoTurns();
    const r2 = await s.undo(b2);
    expect(r2.batch.undo?.skipped).toEqual([]);
    expect(await s.read('shared.txt')).toBe('s1\n');
    const r1 = await s.undo(b1);
    expect(r1.batch.undo).toMatchObject({ restored: ['only1.txt', 'shared.txt'], skipped: [] });
    expect(await s.read('shared.txt')).toBe('s0\n');
    expect(await s.read('only1.txt')).toBe('o0\n');
    expect(await s.read('only2.txt')).toBe('p0\n');
    expect(await s.blobs()).toEqual([]);
  });

  it('undo the earlier turn first: the shared file is skipped, the rest restored; then the later turn', async () => {
    const { s, b1, b2 } = await twoTurns();
    const r1 = await s.undo(b1);
    expect(r1.batch.undo).toMatchObject({
      restored: ['only1.txt'],
      skipped: [{ path: 'shared.txt', reason: 'changed_since' }],
    });
    expect(await s.read('shared.txt')).toBe('s2\n');
    const r2 = await s.undo(b2);
    expect(r2.batch.undo?.restored).toEqual(['only2.txt', 'shared.txt']);
    expect(await s.read('shared.txt')).toBe('s1\n'); // the later turn's own original
  });
});

describe('undoBatch: refusals', () => {
  it('an unknown batch or chat is not_found; an unknown chat does not get a store file', async () => {
    const s = await setupAuto();
    await expect(s.undo('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.undo('nope', { chatId: 'ghost' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.undo('nope', { chatId: '../x' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await fs.stat(s.storeFile('ghost')).catch(() => null)).toBeNull();
  });

  it('a review batch is a conflict', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a\n');
    await s.turn({ mode: 'review' }).stage('a.txt', 'b\n');
    const p = (await s.get()).pending;
    const decisions = {
      'a.txt': Object.fromEntries((p?.files[0]?.hunks ?? []).map((h) => [h.id, 'accepted' as const])),
    };
    const res = await s.svc.apply({ chatId: 'chat1', projectRoot: s.root, revision: p?.revision ?? 0, decisions });
    expect(res.batch).toMatchObject({ source: 'review', undoable: false });
    await expect(s.undo(res.batch.id)).rejects.toMatchObject({ code: 'conflict', message: CONFLICT_MESSAGE });
    expect(await s.read('a.txt')).toBe('b\n');
  });

  it('a batch from another project is a conflict (with or without chatProjectId), and nothing is touched', async () => {
    for (const withDep of [false, true]) {
      const s = await setupAuto(withDep ? { chatProjectId: async () => 'p' } : {});
      await s.seed('a.txt', 'orig\n');
      await s.readPut(s.turn({ projectId: 'p' }), 'a.txt', 'new\n');
      const id = (await s.get()).applied[0]?.id as string;
      await expect(s.undo(id, { projectId: 'other' })).rejects.toMatchObject({
        code: 'conflict',
        message: CONFLICT_MESSAGE,
      });
      expect(await s.read('a.txt')).toBe('new\n');
      expect((await s.get()).applied[0]?.undoable).toBe(true);
      expect(await s.retry('t1', { projectId: 'other' })).toBeNull(); // retry leaves it alone too
      expect(await s.read('a.txt')).toBe('new\n');
      await s.undo(id); // the right project still can
      expect(await s.read('a.txt')).toBe('orig\n');
    }
  });

  it('a batch past retention is a conflict', async () => {
    const s = await setupAuto();
    for (let i = 1; i <= 21; i++) {
      await s.seed(`f${i}.txt`, `o${i}\n`);
      await s.readPut(s.turn({ turnId: `t${i}` }), `f${i}.txt`, `n${i}\n`);
    }
    const { applied } = await s.get();
    expect(applied[0]?.undoable).toBe(false);
    await expect(s.undo(applied[0]?.id as string)).rejects.toMatchObject({
      code: 'conflict',
      message: CONFLICT_MESSAGE,
    });
    expect(await s.read('f1.txt')).toBe('n1\n');
    await s.undo(applied[1]?.id as string); // the next one is still within the window
    expect(await s.read('f2.txt')).toBe('o2\n');
  }, 30_000);
});

describe('undoable and the chat’s project (chatProjectId)', () => {
  it('get, apply and discard mark a batch of another project (or a chat without one) as not undoable', async () => {
    let current: string | null = 'p';
    const s = await setupAuto({ chatProjectId: async () => current });
    await s.seed('a.txt', 'a\n');
    await s.readPut(s.turn({ projectId: 'p' }), 'a.txt', 'b\n');
    expect((await s.get()).applied[0]?.undoable).toBe(true);
    current = 'moved';
    expect((await s.get()).applied[0]?.undoable).toBe(false);
    expect((await s.svc.discard('chat1')).applied[0]?.undoable).toBe(false);
    current = null;
    expect((await s.get()).applied[0]?.undoable).toBe(false);
    current = 'p';
    expect((await s.get()).applied[0]?.undoable).toBe(true);
    await s.svc.discard('chat1');
    // apply
    await s.turn({ mode: 'review' }).stage('a.txt', 'c\n');
    const p = (await s.get()).pending;
    const decisions = {
      'a.txt': Object.fromEntries((p?.files[0]?.hunks ?? []).map((h) => [h.id, 'accepted' as const])),
    };
    current = 'moved';
    const res = await s.svc.apply({ chatId: 'chat1', projectRoot: s.root, revision: p?.revision ?? 0, decisions });
    expect(res.changes.applied.find((b) => b.source === 'auto')?.undoable).toBe(false);
  });

  it('a failing chatProjectId counts as "no project"; omitting it skips the check', async () => {
    const failing = await setupAuto({
      chatProjectId: async () => {
        throw new Error('db down');
      },
    });
    await failing.readPut(failing.turn(), 'a.txt', 'x\n');
    expect((await failing.get()).applied[0]?.undoable).toBe(false);

    const plain = await setupAuto();
    await plain.readPut(plain.turn(), 'a.txt', 'x\n');
    expect((await plain.get()).applied[0]?.undoable).toBe(true);
  });
});

describe('undo and the next note', () => {
  it('a user undo adds an undone entry to the next note, exactly once; a retry undo adds none', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a0\n');
    await s.seed('b.txt', 'b0\n');
    await s.seed('c.txt', 'c0\n');
    await s.svc.takeNote('chat1', { mode: 'auto', firstTurn: true });
    const t1 = s.turn({ turnId: 't1' });
    await s.readPut(t1, 'a.txt', 'a1\n');
    await s.readPut(t1, 'b.txt', 'b1\n');
    const t2 = s.turn({ turnId: 't2' });
    await s.readPut(t2, 'c.txt', 'c1\n');
    await fs.writeFile(s.abs('b.txt'), 'b by user\n');
    const [b1, b2] = (await s.get()).applied.map((b) => b.id);
    await s.undo(b1 as string);
    expect(await s.svc.takeNote('chat1', { mode: 'auto', firstTurn: false })).toBe(
      [
        '[OpenVern] Since your last reply the user undid your edits from an earlier turn:',
        '- Restored to their earlier content: a.txt',
        '- Not undone, changed since: b.txt',
      ].join('\n'),
    );
    expect(await s.svc.takeNote('chat1', { mode: 'auto', firstTurn: false })).toBeUndefined();
    // A retry's undo doesn't reach the note.
    expect(await s.retry('t2')).toMatchObject({ batchId: b2, undo: { by: 'retry', restored: ['c.txt'] } });
    expect(await s.svc.takeNote('chat1', { mode: 'auto', firstTurn: false })).toBeUndefined();
    expect((await s.readStore()).undone).toBeUndefined();
  });

  it('two user undos before the next reply are reported together', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a0\n');
    await s.seed('b.txt', 'b0\n');
    await s.readPut(s.turn({ turnId: 't1' }), 'a.txt', 'a1\n');
    await s.readPut(s.turn({ turnId: 't2' }), 'b.txt', 'b1\n');
    for (const b of (await s.get()).applied) await s.undo(b.id);
    expect(await s.svc.takeNote('chat1', { mode: 'review', firstTurn: false })).toContain(
      '- Restored to their earlier content: a.txt, b.txt',
    );
  });

  it('a user undo where every file was skipped still reports it', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a0\n');
    await s.readPut(s.turn(), 'a.txt', 'a1\n');
    await fs.writeFile(s.abs('a.txt'), 'user\n');
    await s.undo((await s.get()).applied[0]?.id as string);
    const note = await s.svc.takeNote('chat1', { mode: 'review', firstTurn: false });
    expect(note).toContain('- Not undone, changed since: a.txt');
    expect(note).not.toContain('Restored');
  });
});

describe('prepareRetry', () => {
  it('returns null when there is nothing to undo and leaves review batches alone', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a\n');
    await s.turn({ mode: 'review', turnId: 'tR' }).stage('a.txt', 'b\n');
    const p = (await s.get()).pending;
    const decisions = {
      'a.txt': Object.fromEntries((p?.files[0]?.hunks ?? []).map((h) => [h.id, 'accepted' as const])),
    };
    const applied = await s.svc.apply({ chatId: 'chat1', projectRoot: s.root, revision: p?.revision ?? 0, decisions });
    const before = await s.get();
    // Same turn id as the review turn, a never-seen turn id, and a fresh chat.
    expect(await s.retry('tR')).toBeNull();
    expect(await s.retry('unknown')).toBeNull();
    expect(await s.retry('tR', { chatId: 'fresh-chat' })).toBeNull();
    expect(await s.read('a.txt')).toBe('b\n');
    expect(await s.get()).toEqual(before);
    expect(applied.batch.source).toBe('review');
  });

  it('undoes the turn’s batch (and only that turn’s) and reports it as a retry', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a0\n');
    await s.seed('b.txt', 'b0\n');
    await s.readPut(s.turn({ turnId: 't1' }), 'a.txt', 'a1\n');
    await s.readPut(s.turn({ turnId: 't2' }), 'b.txt', 'b1\n');
    const [b1, b2] = (await s.get()).applied.map((b) => b.id);
    const res = await s.retry('t2');
    expect(res).toMatchObject({ batchId: b2, undo: { by: 'retry', restored: ['b.txt'], skipped: [] } });
    expect(await s.read('b.txt')).toBe('b0\n');
    expect(await s.read('a.txt')).toBe('a1\n');
    const { applied, diskSeq } = await s.get();
    expect(applied.find((b) => b.id === b1)?.undoable).toBe(true);
    expect(applied.find((b) => b.id === b2)).toMatchObject({ undoable: false, undo: { by: 'retry' } });
    expect(diskSeq).toBe(3); // two writes + the restore
  });

  it('files changed since are skipped and returned, and stay as they are', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a0\n');
    await s.seed('b.txt', 'b0\n');
    const t = s.turn({ turnId: 't1' });
    await s.readPut(t, 'a.txt', 'a1\n');
    await s.readPut(t, 'b.txt', 'b1\n');
    await fs.writeFile(s.abs('a.txt'), 'a1 + user\n');
    const res = await s.retry('t1');
    expect(res?.undo).toMatchObject({
      by: 'retry',
      restored: ['b.txt'],
      skipped: [{ path: 'a.txt', reason: 'changed_since' }],
    });
    expect(await s.read('a.txt')).toBe('a1 + user\n');
  });

  it('records the mode as the last noted mode (no mode line afterwards), and works in either mode', async () => {
    const s = await setupAuto();
    // A store with no lastMode counts as Review: without the retry, an Auto note would carry a mode line.
    expect(await s.retry('t1', { mode: 'auto' })).toBeNull();
    expect(await s.svc.takeNote('chat1', { mode: 'auto', firstTurn: false })).toBeUndefined();
    // Retry in Review after an Auto note: now Review is recorded.
    expect(await s.retry('t1', { mode: 'review' })).toBeNull();
    expect(await s.svc.takeNote('chat1', { mode: 'review', firstTurn: false })).toBeUndefined();
    expect(await s.svc.takeNote('chat1', { mode: 'auto', firstTurn: false })).toBe(modeChangedNote('auto'));
  });

  it('undoes an Auto batch even when the retry runs in Review, and clears the read record', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'a0\n');
    await s.readPut(s.turn({ turnId: 't1' }), 'a.txt', 'a1\n');
    const res = await s.retry('t1', { mode: 'review' });
    expect(res?.undo.restored).toEqual(['a.txt']);
    expect(await s.read('a.txt')).toBe('a0\n');
    await expect(s.put(s.turn({ turnId: 't1' }), 'a.txt', 'x\n')).rejects.toMatchObject({
      message: autoUnreadText('a.txt'),
    });
  });

  it('skips a batch past retention without throwing', async () => {
    const s = await setupAuto();
    for (let i = 1; i <= 21; i++) {
      await s.seed(`f${i}.txt`, `o${i}\n`);
      await s.readPut(s.turn({ turnId: `t${i}` }), `f${i}.txt`, `n${i}\n`);
    }
    expect(await s.retry('t1')).toBeNull();
    expect(await s.read('f1.txt')).toBe('n1\n');
    expect((await s.retry('t21'))?.undo.restored).toEqual(['f21.txt']);
  }, 30_000);
});
