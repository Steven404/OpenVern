// Auto-mode writes straight to disk: the sandbox, the hash and stale-read checks, the per-file lock, the stored
// originals and review apply's write path. Real temp project folder, real data dir; races are driven by the
// `beforeWrite` hook (it runs inside the file's write lock), never by timing.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import type { HunkDecision } from '@shared/types';
import { describe, expect, it } from 'vitest';
import {
  autoPendingText,
  autoSourceTooLargeText,
  autoStaleText,
  autoUnreadText,
  autoWriteFailedText,
} from '../agent/edit-mode';
import { cleanupTempDirs } from '../storage/test-helpers';
import { type AutoSetup, flush, gate, setupAuto, waitFor } from './auto-test-helpers';
import { sha256 } from './blobs';
import { fileLockKey } from './write-lock';

cleanupTempDirs();

const LIMIT_TEST = 30_000;

describe('auto write: results and the turn batch', () => {
  it('modifies atomically, returns this write’s diff, and leaves no temp files', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'one\ntwo\nthree\n');
    const tc = s.turn();
    await s.readFile(tc, 'a.txt');
    const r = await s.put(tc, 'a.txt', 'one\nTWO\nthree\n', 'edit_file');
    expect(await s.read('a.txt')).toBe('one\nTWO\nthree\n');
    expect(r.batchId).toEqual(expect.any(String));
    expect(r.file).toMatchObject({ path: 'a.txt', kind: 'modify', add: 1, del: 1 });
    expect(r.file?.hunks).toHaveLength(1);
    expect(r.file?.hunks[0]?.lines).toEqual([' one', '-two', '+TWO', ' three']);
    expect(await fs.readdir(s.root)).toEqual(['a.txt']);
  });

  it('creates a file and its missing parent folders (default mode 0644)', async () => {
    const s = await setupAuto();
    const r = await s.put(s.turn(), 'deep/er/new.txt', 'hello\nworld\n');
    expect(await s.read('deep/er/new.txt')).toBe('hello\nworld\n');
    expect(r.file).toMatchObject({ path: 'deep/er/new.txt', kind: 'create', add: 2, del: 0 });
    expect(await s.modeOf('deep/er/new.txt')).toBe(0o644);
    const batch = (await s.get()).applied[0];
    expect(batch?.written.map((f) => [f.path, f.kind])).toEqual([['deep/er/new.txt', 'create']]);
  });

  it('deletes a file', async () => {
    const s = await setupAuto();
    await s.seed('gone.txt', 'a\nb\n');
    const tc = s.turn();
    await s.readFile(tc, 'gone.txt');
    const r = await s.put(tc, 'gone.txt', null, 'delete_file');
    expect(await s.exists('gone.txt')).toBe(false);
    expect(r.file).toMatchObject({ path: 'gone.txt', kind: 'delete', add: 0, del: 2 });
    expect((await s.get()).applied[0]?.written.map((f) => [f.path, f.kind])).toEqual([['gone.txt', 'delete']]);
  });

  it('deletes a binary file; undo restores its exact bytes and mode', async () => {
    const s = await setupAuto();
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 3]);
    await s.seed('img.bin', bytes, 0o640);
    const tc = s.turn();
    await s.readFile(tc, 'img.bin');
    const r = await s.put(tc, 'img.bin', null, 'delete_file');
    expect(r.file).toMatchObject({ kind: 'delete', add: 0, del: 0 });
    expect(await s.exists('img.bin')).toBe(false);
    const res = await s.undo(r.batchId as string);
    expect(res.batch.undo).toMatchObject({ by: 'user', restored: ['img.bin'], skipped: [] });
    expect((await s.readBuf('img.bin')).equals(bytes)).toBe(true);
    expect(await s.modeOf('img.bin')).toBe(0o640);
  });

  it('deletes and restores a file that is invalid UTF-8 without a NUL byte', async () => {
    const s = await setupAuto();
    const bytes = Buffer.from([0xff, 0xfe, 0x41, 0xc3, 0x28]);
    await s.seed('latin.txt', bytes);
    const tc = s.turn();
    await s.readFile(tc, 'latin.txt');
    await expect(s.put(tc, 'latin.txt', 'text')).rejects.toMatchObject({ code: 'unsupported_file' });
    const r = await s.put(tc, 'latin.txt', null, 'delete_file');
    await s.undo(r.batchId as string);
    expect((await s.readBuf('latin.txt')).equals(bytes)).toBe(true);
  });

  it('refuses to edit or overwrite a binary file, and leaves it alone', async () => {
    const s = await setupAuto();
    const bytes = Buffer.from([1, 2, 0, 3]);
    await s.seed('b.dat', bytes);
    const tc = s.turn();
    await s.readFile(tc, 'b.dat');
    for (const tool of ['edit_file', 'write_file'] as const) {
      await expect(s.put(tc, 'b.dat', 'text', tool)).rejects.toMatchObject({ code: 'unsupported_file' });
    }
    expect((await s.readBuf('b.dat')).equals(bytes)).toBe(true);
    expect((await s.get()).applied).toEqual([]);
    expect((await s.get()).diskSeq).toBe(0);
  });

  it('two writes to one file in a turn: one entry, diff from the original, one blob, first message id', async () => {
    const s = await setupAuto();
    await s.seed('f.txt', 'a\nb\nc\n');
    const t1 = s.turn({ messageId: 'step1' });
    await s.readFile(t1, 'f.txt');
    const r1 = await s.put(t1, 'f.txt', 'a\nB\nc\n');
    const t2 = s.turn({ messageId: 'step2' });
    const r2 = await s.put(t2, 'f.txt', 'a\nB\nC\n');
    // Each write returns its own diff…
    expect(r1.file).toMatchObject({ add: 1, del: 1 });
    expect(r2.file?.hunks[0]?.lines).toEqual([' a', ' B', '-c', '+C']);
    expect(r2.file).toMatchObject({ add: 1, del: 1 });
    expect(r2.batchId).toBe(r1.batchId);
    // …and the batch holds one entry diffed from before the turn.
    const { applied } = await s.get();
    expect(applied).toHaveLength(1);
    expect(applied[0]?.messageId).toBe('step1');
    expect(applied[0]?.written).toHaveLength(1);
    expect(applied[0]?.written[0]).toMatchObject({ path: 'f.txt', kind: 'modify', add: 2, del: 2 });
    expect(await s.blobs()).toEqual([sha256('a\nb\nc\n')]);
    expect(await s.read('f.txt')).toBe('a\nB\nC\n');
  });

  it('create then delete in one turn leaves no entry, no batch and no blob', async () => {
    const s = await setupAuto();
    const tc = s.turn();
    const created = await s.put(tc, 'tmp.txt', 'x\n');
    const deleted = await s.put(tc, 'tmp.txt', null, 'delete_file');
    expect(await s.exists('tmp.txt')).toBe(false);
    expect(deleted.batchId).toBe(created.batchId);
    expect((await s.get()).applied).toEqual([]);
    expect(await s.blobs()).toEqual([]);
  });

  it('modify then restore the original text: the entry is dropped and its blob collected', async () => {
    const s = await setupAuto();
    await s.seed('f.txt', 'orig\n');
    await s.seed('other.txt', 'o1\n');
    const tc = s.turn();
    await s.readPut(tc, 'other.txt', 'o2\n');
    await s.readPut(tc, 'f.txt', 'changed\n');
    expect(await s.blobs()).toHaveLength(2);
    await s.put(tc, 'f.txt', 'orig\n');
    const { applied } = await s.get();
    expect(applied[0]?.written.map((f) => f.path)).toEqual(['other.txt']);
    expect(await s.blobs()).toEqual([sha256('o1\n')]);
    // Undo only touches what is still listed.
    await s.undo(applied[0]?.id as string);
    expect(await s.read('f.txt')).toBe('orig\n');
    expect(await s.read('other.txt')).toBe('o1\n');
  });

  it('a new turn starts a new batch; each keeps its own original', async () => {
    const s = await setupAuto();
    await s.seed('f.txt', '1\n');
    const a = s.turn({ turnId: 'tA', messageId: 'mA' });
    const ra = await s.readPut(a, 'f.txt', '2\n');
    const b = s.turn({ turnId: 'tB', messageId: 'mB' });
    const rb = await s.put(b, 'f.txt', '3\n');
    expect(ra.batchId).not.toBe(rb.batchId);
    const { applied } = await s.get();
    expect(applied.map((x) => [x.turnId, x.messageId])).toEqual([
      ['tA', 'mA'],
      ['tB', 'mB'],
    ]);
    expect(await s.blobs()).toEqual([sha256('1\n'), sha256('2\n')].sort());
  });

  it('diskSeq bumps on every write, not on a refusal or a no-change write', async () => {
    const s = await setupAuto();
    await s.seed('f.txt', 'a\n');
    const tc = s.turn();
    expect((await s.get()).diskSeq).toBe(0);
    await s.readPut(tc, 'f.txt', 'b\n');
    expect((await s.get()).diskSeq).toBe(1);
    await s.put(tc, 'f.txt', 'c\n');
    expect((await s.get()).diskSeq).toBe(2);
    await s.put(tc, 'new.txt', 'n\n');
    expect((await s.get()).diskSeq).toBe(3);
    await s.put(tc, 'new.txt', null, 'delete_file');
    expect((await s.get()).diskSeq).toBe(4);
    // Same bytes again: nothing written, nothing bumped, no batch id.
    expect(await s.put(tc, 'f.txt', 'c\n')).toEqual({ file: null, batchId: null });
    // A refusal: nothing bumped.
    await expect(s.put(tc, '.env', 'x\n')).rejects.toBeTruthy();
    await expect(tc.write('f.txt', 'z\n', { tool: 'write_file', baseHash: 'nope' })).rejects.toBeTruthy();
    expect((await s.get()).diskSeq).toBe(4);
  });

  it('a write that changes nothing on an untouched file records nothing', async () => {
    const s = await setupAuto();
    await s.seed('f.txt', 'same\n');
    const tc = s.turn();
    await s.readFile(tc, 'f.txt');
    expect(await s.put(tc, 'f.txt', 'same\n')).toEqual({ file: null, batchId: null });
    expect(await s.get()).toEqual({ pending: null, applied: [], diskSeq: 0 });
    expect(await s.blobs()).toEqual([]);
  });

  it('the batch has source auto, turnId, the first write’s messageId, undoable true, and leaks no internals', async () => {
    const s = await setupAuto();
    await s.seed('f.txt', 'a\n');
    const first = s.turn({ turnId: 'turn-7', messageId: 'msg-first' });
    await s.readPut(first, 'f.txt', 'b\n');
    await s.put(s.turn({ turnId: 'turn-7', messageId: 'msg-second' }), 'g.txt', 'g\n');
    const { applied } = await s.get();
    expect(applied).toHaveLength(1);
    const batch = applied[0];
    expect(batch).toMatchObject({
      source: 'auto',
      turnId: 'turn-7',
      messageId: 'msg-first',
      undoable: true,
      rejectedHunks: 0,
      skippedHunks: 0,
      conflicts: [],
    });
    expect(batch?.written.map((f) => f.path)).toEqual(['f.txt', 'g.txt']);
    expect(Date.parse(batch?.appliedAt ?? '')).not.toBeNaN();
    expect(batch).not.toHaveProperty('undoData');
    expect(batch).not.toHaveProperty('projectId');
    expect(batch).not.toHaveProperty('undo');
  });

  it('appliedAt is the time of the latest write', async () => {
    const s = await setupAuto();
    const tc = s.turn();
    await s.put(tc, 'a.txt', '1\n');
    const t1 = (await s.get()).applied[0]?.appliedAt as string;
    await new Promise((r) => setTimeout(r, 5));
    await s.put(tc, 'b.txt', '2\n');
    const t2 = (await s.get()).applied[0]?.appliedAt as string;
    expect(Date.parse(t2)).toBeGreaterThan(Date.parse(t1));
  });

  it('keeps CRLF when the model writes plain LF, and the permission bits on modify', async () => {
    const s = await setupAuto();
    await s.seed('crlf.txt', 'a\r\nb\r\n');
    await s.seed('run.sh', '#!/bin/sh\necho 1\n', 0o755);
    await s.seed('priv.txt', 'secret-ish\n', 0o600);
    await s.seed('odd.txt', 'x\n', 0o664);
    const tc = s.turn();
    await s.readPut(tc, 'crlf.txt', 'a\nB\nc\n');
    expect(await s.read('crlf.txt')).toBe('a\r\nB\r\nc\r\n');
    for (const [rel, mode] of [
      ['run.sh', 0o755],
      ['priv.txt', 0o600],
      ['odd.txt', 0o664],
    ] as const) {
      await s.readPut(tc, rel, `new ${rel}\n`);
      expect(await s.modeOf(rel), rel).toBe(mode);
    }
    // A second write in the turn keeps them too.
    await s.put(tc, 'run.sh', 'again\n');
    expect(await s.modeOf('run.sh')).toBe(0o755);
  });

  it('refuses a directory target and deleting a missing file', async () => {
    const s = await setupAuto();
    await fs.mkdir(s.abs('dir'));
    const tc = s.turn();
    await expect(s.put(tc, 'dir', 'x\n')).rejects.toMatchObject({ code: 'path_invalid' });
    await expect(s.put(tc, 'nothing.txt', null, 'delete_file')).rejects.toMatchObject({ code: 'not_found' });
    expect((await s.get()).applied).toEqual([]);
  });
});

describe('auto write: boundaries', () => {
  async function expectRefused(s: AutoSetup, rel: string, code = 'path_invalid') {
    const tc = s.turn();
    await expect(s.put(tc, rel, 'x\n'), `${rel} (write)`).rejects.toMatchObject({ code });
    await expect(s.put(tc, rel, 'x\n', 'edit_file'), `${rel} (edit)`).rejects.toMatchObject({ code });
    await expect(
      tc.write(rel, null, { tool: 'delete_file', baseHash: await s.hashNow(rel) }),
      `${rel} (delete)`,
    ).rejects.toBeTruthy();
    expect((await s.get()).applied).toEqual([]);
    expect((await s.get()).diskSeq).toBe(0);
    expect(await s.blobs()).toEqual([]);
  }

  it('refuses .env, .git/config and key files, existing or not, without touching them', async () => {
    const s = await setupAuto();
    await s.seed('.env', 'K=1\n');
    await s.seed('.git/config', '[core]\n');
    await s.seed('certs/server.pem', 'PEM\n');
    await s.seed('id_rsa', 'KEY\n');
    await s.seed('.env.local', 'L=1\n');
    for (const rel of [
      '.env',
      '.git/config',
      'certs/server.pem',
      'id_rsa',
      '.env.local',
      '.git/hooks/pre-commit',
      'new.key',
    ]) {
      await expectRefused(s, rel);
    }
    expect(await s.read('.env')).toBe('K=1\n');
    expect(await s.read('.git/config')).toBe('[core]\n');
    expect(await s.read('id_rsa')).toBe('KEY\n');
    expect(await s.exists('.git/hooks/pre-commit')).toBe(false);
    expect(await s.exists('new.key')).toBe(false);
  });

  it('refuses the app data dir when it lies inside the project', async () => {
    const s = await setupAuto({ dataDirInsideProject: true });
    const secretsLike = path.join(s.dataDir, 'chats', 'x.txt');
    await fs.writeFile(secretsLike, 'DATA\n');
    await expectRefused(s, 'appdata/chats/x.txt');
    await expectRefused(s, 'appdata/chats/new.txt');
    await expectRefused(s, 'appdata/brand-new-folder/new.txt');
    expect(await fs.readFile(secretsLike, 'utf8')).toBe('DATA\n');
    // The rest of the project is still writable.
    await s.put(s.turn(), 'fine.txt', 'ok\n');
    expect(await s.read('fine.txt')).toBe('ok\n');
  });

  it('refuses ../ escapes and absolute paths outside the project', async () => {
    const s = await setupAuto();
    await fs.writeFile(path.join(s.outside, 'victim.txt'), 'V\n');
    await expectRefused(s, '../outside/victim.txt');
    await expectRefused(s, '../escape.txt');
    await expectRefused(s, 'sub/../../escape.txt');
    await expectRefused(s, path.join(s.outside, 'victim.txt'));
    await expectRefused(s, path.join(s.outside, 'created.txt'));
    expect(await fs.readFile(path.join(s.outside, 'victim.txt'), 'utf8')).toBe('V\n');
    expect(await fs.readdir(s.outside)).toEqual(['victim.txt']);
    expect(await fs.readdir(path.dirname(s.root))).not.toContain('escape.txt');
  });

  it('refuses a symlinked file (to outside or inside) and a symlinked parent folder', async () => {
    const s = await setupAuto();
    await fs.writeFile(path.join(s.outside, 'target.txt'), 'T\n');
    await s.seed('real.txt', 'R\n');
    await fs.symlink(path.join(s.outside, 'target.txt'), s.abs('link-out.txt'));
    await fs.symlink(s.abs('real.txt'), s.abs('link-in.txt'));
    await fs.symlink(s.outside, s.abs('linkdir'));
    await fs.symlink('/nonexistent-target-xyz', s.abs('dangling.txt'));
    for (const rel of [
      'link-out.txt',
      'link-in.txt',
      'linkdir/target.txt',
      'linkdir/new.txt',
      'linkdir/sub/new.txt',
      'dangling.txt',
    ]) {
      await expectRefused(s, rel);
    }
    expect(await fs.readFile(path.join(s.outside, 'target.txt'), 'utf8')).toBe('T\n');
    expect(await fs.readdir(s.outside)).toEqual(['target.txt']);
    expect(await s.read('real.txt')).toBe('R\n');
    expect((await fs.lstat(s.abs('link-out.txt'))).isSymbolicLink()).toBe(true);
  });

  it('refuses a new file when its parent folder is replaced by a symlink between mkdir and the write', async () => {
    const s = await setupAuto();
    await fs.mkdir(path.join(s.outside, 'sub'));
    let ran = 0;
    s.hooks.beforeWrite = async (info) => {
      ran++;
      expect(info).toEqual({ op: 'auto', chatId: 'chat1', path: 'newdir/sub/f.txt' });
      // mkdir has already created newdir/sub; swap newdir for a link to the outside folder.
      await fs.rm(s.abs('newdir'), { recursive: true });
      await fs.symlink(s.outside, s.abs('newdir'));
    };
    await expect(s.put(s.turn(), 'newdir/sub/f.txt', 'pwn\n')).rejects.toMatchObject({ code: 'path_invalid' });
    expect(ran).toBe(1);
    expect(await fs.readdir(path.join(s.outside, 'sub'))).toEqual([]);
    expect(await fs.readdir(s.outside)).toEqual(['sub']);
    expect(await s.get()).toEqual({ pending: null, applied: [], diskSeq: 0 });
    expect(await s.blobs()).toEqual([]);
  });

  it('refuses an existing file that is swapped for a symlink inside the lock; the target is untouched', async () => {
    const s = await setupAuto();
    await fs.writeFile(path.join(s.outside, 'target.txt'), 'T\n');
    await s.seed('a.txt', 'A\n');
    const tc = s.turn();
    await s.readFile(tc, 'a.txt');
    s.hooks.beforeWrite = async () => {
      await fs.rm(s.abs('a.txt'));
      await fs.symlink(path.join(s.outside, 'target.txt'), s.abs('a.txt'));
    };
    await expect(s.put(tc, 'a.txt', 'pwn\n', 'edit_file')).rejects.toMatchObject({ code: 'path_invalid' });
    expect(await fs.readFile(path.join(s.outside, 'target.txt'), 'utf8')).toBe('T\n');
    expect((await fs.lstat(s.abs('a.txt'))).isSymbolicLink()).toBe(true);
    expect((await s.get()).applied).toEqual([]);
    expect(await s.blobs()).toEqual([]);
  });

  it('refuses content over writeFileMaxBytes (counted in bytes), with NUL, lone surrogates and placeholders', async () => {
    const s = await setupAuto();
    await s.seed('keep.txt', 'keep\n');
    const tc = s.turn();
    await s.readFile(tc, 'keep.txt');
    const cases: [string, string, string][] = [
      ['too big', 'x'.repeat(LIMITS.writeFileMaxBytes + 1), 'file_too_large'],
      // 2 bytes per character: fewer characters than the limit, more bytes.
      ['too big in bytes', 'é'.repeat(LIMITS.writeFileMaxBytes / 2 + 1), 'file_too_large'],
      ['NUL', 'a\0b', 'unsupported_file'],
      ['lone high surrogate', 'a\ud800b', 'unsupported_file'],
      ['lone low surrogate', 'a\udc00b', 'unsupported_file'],
      ['placeholder', 'key «redacted:openrouter»\n', 'invalid_request'],
    ];
    for (const [name, content, code] of cases) {
      for (const rel of ['keep.txt', 'brand-new.txt']) {
        await expect(s.put(tc, rel, content), `${name} -> ${rel}`).rejects.toMatchObject({ code });
      }
    }
    expect(await s.read('keep.txt')).toBe('keep\n');
    expect(await s.exists('brand-new.txt')).toBe(false);
    expect((await s.get()).applied).toEqual([]);
    expect(await s.blobs()).toEqual([]);
  });

  it('accepts exactly writeFileMaxBytes, and a valid surrogate pair', async () => {
    const s = await setupAuto();
    const tc = s.turn();
    await s.put(tc, 'max.txt', 'x'.repeat(LIMITS.writeFileMaxBytes));
    expect((await s.readBuf('max.txt')).length).toBe(LIMITS.writeFileMaxBytes);
    await s.put(tc, 'emoji.txt', 'ok 😀\n');
    expect(await s.read('emoji.txt')).toBe('ok 😀\n');
  });
});

describe('auto write: more edges', () => {
  it('a parent folder swapped for a symlink before a delete is refused; the outside file survives', async () => {
    const s = await setupAuto();
    await fs.writeFile(path.join(s.outside, 'x.txt'), 'OUTSIDE\n');
    await s.seed('dir/x.txt', 'inside\n');
    const tc = s.turn();
    await s.readFile(tc, 'dir/x.txt');
    s.hooks.beforeWrite = async () => {
      await fs.rm(s.abs('dir'), { recursive: true });
      await fs.symlink(s.outside, s.abs('dir'));
    };
    await expect(s.put(tc, 'dir/x.txt', null, 'delete_file')).rejects.toMatchObject({ code: 'path_invalid' });
    expect(await fs.readFile(path.join(s.outside, 'x.txt'), 'utf8')).toBe('OUTSIDE\n');
    expect((await s.get()).applied).toEqual([]);
  });

  it('review apply: a parent folder swapped for a symlink before a delete does not delete the outside file', async () => {
    const s = await setupAuto();
    await fs.writeFile(path.join(s.outside, 'x.txt'), 'OUTSIDE\n');
    await s.seed('dir/x.txt', 'inside\n');
    await s.turn({ mode: 'review' }).stage('dir/x.txt', null);
    const p = (await s.get()).pending;
    const decisions = {
      'dir/x.txt': Object.fromEntries((p?.files[0]?.hunks ?? []).map((h) => [h.id, 'accepted' as const])),
    };
    s.hooks.beforeWrite = async () => {
      await fs.rm(s.abs('dir'), { recursive: true });
      await fs.symlink(s.outside, s.abs('dir'));
    };
    const res = await s.svc.apply({ chatId: 'chat1', projectRoot: s.root, revision: p?.revision ?? 0, decisions });
    expect(await fs.readFile(path.join(s.outside, 'x.txt'), 'utf8')).toBe('OUTSIDE\n');
    expect(res.batch.written).toEqual([]);
    expect(res.batch.conflicts).toEqual([{ path: 'dir/x.txt', reason: 'blocked' }]);
  });

  it('empty files: create, modify and delete round-trip through undo', async () => {
    const s = await setupAuto();
    await s.seed('empty.txt', '');
    await s.seed('gone-empty.txt', '');
    const tc = s.turn();
    await s.readPut(tc, 'empty.txt', 'now text\n');
    await s.readPut(tc, 'gone-empty.txt', null, 'delete_file');
    await s.put(tc, 'made-empty.txt', '');
    expect(await s.exists('made-empty.txt')).toBe(true);
    await s.undo((await s.get()).applied[0]?.id as string);
    expect((await s.readBuf('empty.txt')).length).toBe(0);
    expect(await s.exists('gone-empty.txt')).toBe(true);
    expect((await s.readBuf('gone-empty.txt')).length).toBe(0);
    expect(await s.exists('made-empty.txt')).toBe(false);
  });

  it('a file created and then modified in one turn is removed by undo', async () => {
    const s = await setupAuto();
    const tc = s.turn();
    await s.put(tc, 'new.txt', 'v1\n');
    await s.put(tc, 'new.txt', 'v2\n');
    const [batch] = (await s.get()).applied;
    expect(batch?.written).toHaveLength(1);
    expect(batch?.written[0]).toMatchObject({ kind: 'create', add: 1 });
    await s.undo(batch?.id as string);
    expect(await s.exists('new.txt')).toBe(false);
  });
});

/** Stages `content` for `rel` in Review and returns apply's input accepting every hunk. */
async function stageAll(s: AutoSetup, rel: string, content: string | null) {
  await s.turn({ mode: 'review' }).stage(rel, content);
  const p = (await s.get()).pending;
  const decisions: Record<string, Record<string, HunkDecision>> = {};
  for (const f of p?.files ?? [])
    decisions[f.path] = Object.fromEntries(f.hunks.map((h) => [h.id, 'accepted' as const]));
  return { chatId: 'chat1', projectRoot: s.root, revision: p?.revision ?? 0, decisions };
}

describe('the file changes after the checks, inside the hook', () => {
  // Every write path checks the file, then awaits (blob write, folder creation, the hook, the re-resolve). The check
  // must be repeated right before the write or unlink, or a change made in between is destroyed.
  it('auto: a modify, create or delete is refused with autoStaleText; the change on disk is kept', async () => {
    const s = await setupAuto();
    await s.seed('mod.txt', 'orig\n');
    await s.seed('del.txt', 'orig\n');
    const tc = s.turn();
    await s.readFile(tc, 'mod.txt');
    await s.readFile(tc, 'del.txt');
    s.hooks.beforeWrite = async (info) => {
      await fs.writeFile(s.abs(info.path), `user ${info.path}\n`);
    };
    for (const [rel, content] of [
      ['mod.txt', 'model\n'],
      ['new.txt', 'model\n'],
      ['del.txt', null],
    ] as const) {
      await expect(s.put(tc, rel, content, content === null ? 'delete_file' : 'write_file')).rejects.toMatchObject({
        code: 'conflict',
        message: autoStaleText(rel),
      });
      expect(await s.read(rel)).toBe(`user ${rel}\n`);
    }
    expect((await s.get()).applied).toEqual([]);
    expect((await s.get()).diskSeq).toBe(0);
    expect(await s.blobs()).toEqual([]);
  });

  it('review apply: a modify, create or delete becomes a conflict; the change on disk is kept', async () => {
    for (const [rel, seed, content, reason] of [
      ['mod.txt', 'orig\n', 'proposed\n', 'changed_on_disk'],
      ['new.txt', null, 'proposed\n', 'exists_on_disk'],
      ['del.txt', 'orig\n', null, 'changed_on_disk'],
    ] as const) {
      const s = await setupAuto();
      if (seed !== null) await s.seed(rel, seed);
      const input = await stageAll(s, rel, content);
      s.hooks.beforeWrite = async () => {
        await fs.writeFile(s.abs(rel), 'user\n');
      };
      const res = await s.svc.apply(input);
      expect(res.batch.written).toEqual([]);
      expect(res.batch.conflicts).toEqual([{ path: rel, reason }]);
      expect(res.changes.diskSeq).toBe(0);
      expect(await s.read(rel)).toBe('user\n');
    }
  });

  it('review apply: a file deleted inside the hook is not recreated (deleted_on_disk)', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'orig\n');
    const input = await stageAll(s, 'a.txt', 'proposed\n');
    s.hooks.beforeWrite = async () => {
      await fs.rm(s.abs('a.txt'));
    };
    const res = await s.svc.apply(input);
    expect(res.batch.conflicts).toEqual([{ path: 'a.txt', reason: 'deleted_on_disk' }]);
    expect(await s.exists('a.txt')).toBe(false);
  });
});

describe('auto write: the source-size limit', () => {
  const L = LIMITS.editSourceMaxBytes;
  /** A text file of exactly `n` bytes. */
  const sized = (n: number) => `${'a'.repeat(n - 1)}\n`;

  it('a file of exactly the limit can be modified and deleted', async () => {
    const s = await setupAuto();
    await s.seed('mod.txt', sized(L));
    await s.seed('del.txt', sized(L));
    const tc = s.turn();
    await expect(s.readPut(tc, 'mod.txt', 'small\n')).resolves.toMatchObject({ batchId: expect.any(String) });
    await expect(s.readPut(tc, 'del.txt', null, 'delete_file')).resolves.toMatchObject({
      batchId: expect.any(String),
    });
    expect(await s.read('mod.txt')).toBe('small\n');
    expect(await s.exists('del.txt')).toBe(false);
  });

  it('a file one byte over the limit is refused for modify and delete, before any copy is kept', async () => {
    const s = await setupAuto();
    await s.seed('mod.txt', sized(L + 1));
    await s.seed('del.txt', sized(L + 1));
    const tc = s.turn();
    for (const [rel, content] of [
      ['mod.txt', 'small\n'],
      ['del.txt', null],
    ] as const) {
      await expect(s.readPut(tc, rel, content, content === null ? 'delete_file' : 'edit_file')).rejects.toMatchObject({
        code: 'file_too_large',
        message: autoSourceTooLargeText(rel),
      });
      expect((await fs.stat(s.abs(rel))).size).toBe(L + 1);
    }
    expect(await s.blobs()).toEqual([]);
    expect((await s.get()).applied).toEqual([]);
  });

  it('a binary file one byte over the limit cannot be deleted either', async () => {
    const s = await setupAuto();
    const bytes = Buffer.alloc(L + 1, 0);
    await s.seed('big.bin', bytes);
    await expect(s.readPut(s.turn(), 'big.bin', null, 'delete_file')).rejects.toMatchObject({
      code: 'file_too_large',
    });
    expect(await s.exists('big.bin')).toBe(true);
    expect(await s.blobs()).toEqual([]);
  });
});

describe('stored originals (the blob folder)', () => {
  it('a blob folder that is a symlink is refused: nothing outside storage is written or deleted', async () => {
    const s = await setupAuto();
    const elsewhere = path.join(s.outside, 'elsewhere');
    await fs.mkdir(elsewhere);
    const unrelatedHash = sha256('not a blob of this chat');
    await fs.writeFile(path.join(elsewhere, 'keep.txt'), 'keep\n');
    await fs.writeFile(path.join(elsewhere, unrelatedHash), 'hash-named\n');
    await fs.mkdir(path.dirname(s.blobDir()), { recursive: true });
    await fs.symlink(elsewhere, s.blobDir());

    await s.seed('a.txt', 'orig\n');
    await expect(s.readPut(s.turn(), 'a.txt', 'new\n')).rejects.toMatchObject({
      code: 'internal',
      message: autoWriteFailedText('a.txt'),
    });
    expect(await s.read('a.txt')).toBe('orig\n');
    expect((await fs.readdir(elsewhere)).sort()).toEqual([unrelatedHash, 'keep.txt'].sort());
    expect(await fs.readFile(path.join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep\n');

    // Removing the chat removes the link, never what it points to.
    await s.svc.removeForChat('chat1');
    expect(await fs.lstat(s.blobDir()).catch(() => null)).toBeNull();
    expect((await fs.readdir(elsewhere)).sort()).toEqual([unrelatedHash, 'keep.txt'].sort());
  });

  it('collecting blobs removes only unreferenced blobs, never other files, folders or link targets', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'orig\n');
    await s.readPut(s.turn(), 'a.txt', 'new\n');
    const dir = s.blobDir();
    expect(await s.blobs()).toEqual([sha256('orig\n')]);
    const target = path.join(s.outside, 'target.txt');
    await fs.writeFile(target, 'outside\n');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'mine\n');
    await fs.mkdir(path.join(dir, 'sub'));
    await fs.writeFile(path.join(dir, 'sub', 'inner.txt'), 'inner\n');
    // A hash-named folder and a hash-named link to an outside file.
    await fs.mkdir(path.join(dir, sha256('folder')));
    await fs.symlink(target, path.join(dir, sha256('link')));

    await s.undo((await s.get()).applied[0]?.id as string); // drops the undo data, then collects
    expect((await s.blobs()).sort()).toEqual(['notes.txt', 'sub', sha256('folder')].sort());
    expect(await fs.readFile(path.join(dir, 'sub', 'inner.txt'), 'utf8')).toBe('inner\n');
    expect(await fs.readFile(target, 'utf8')).toBe('outside\n');
  });
});

describe('auto write: race check and stale-read guard', () => {
  it('a baseHash that differs from the disk is refused with autoStaleText and nothing is written', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'one\n');
    const tc = s.turn();
    await s.readFile(tc, 'a.txt');
    const hashOfOne = await s.hashNow('a.txt');
    await fs.writeFile(s.abs('a.txt'), 'edited by user\n');
    await expect(tc.write('a.txt', 'mine\n', { tool: 'edit_file', baseHash: hashOfOne })).rejects.toMatchObject({
      code: 'conflict',
      message: autoStaleText('a.txt'),
    });
    expect(await s.read('a.txt')).toBe('edited by user\n');
    expect(await s.get()).toEqual({ pending: null, applied: [], diskSeq: 0 });
    expect(await s.blobs()).toEqual([]);
  });

  it('the tool saw "missing" but the file now exists: refused, the file is kept', async () => {
    const s = await setupAuto();
    const tc = s.turn();
    await s.seed('new.txt', 'someone created me\n');
    for (const tool of ['write_file', 'edit_file'] as const) {
      await expect(tc.write('new.txt', 'mine\n', { tool, baseHash: '' })).rejects.toMatchObject({
        code: 'conflict',
        message: autoStaleText('new.txt'),
      });
    }
    expect(await s.read('new.txt')).toBe('someone created me\n');
  });

  it('the tool saw a file that has since been deleted: refused, not recreated', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'one\n');
    const h = await s.hashNow('a.txt');
    await fs.rm(s.abs('a.txt'));
    await expect(s.turn().write('a.txt', 'mine\n', { tool: 'write_file', baseHash: h })).rejects.toMatchObject({
      code: 'conflict',
      message: autoStaleText('a.txt'),
    });
    expect(await s.exists('a.txt')).toBe(false);
  });

  it('write_file over an existing file: no record → autoUnreadText; equal record → ok; stale record → autoStaleText', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'v1\n');
    const tc = s.turn();
    await expect(s.put(tc, 'a.txt', 'mine\n')).rejects.toMatchObject({
      code: 'conflict',
      message: autoUnreadText('a.txt'),
    });
    expect(await s.read('a.txt')).toBe('v1\n');

    tc.noteRead('a.txt', Buffer.from('v1\n'));
    // The user edits after the read: the record is stale (the tool's own baseHash is current).
    await fs.writeFile(s.abs('a.txt'), 'v2 by user\n');
    await expect(s.put(tc, 'a.txt', 'mine\n')).rejects.toMatchObject({
      code: 'conflict',
      message: autoStaleText('a.txt'),
    });
    expect(await s.read('a.txt')).toBe('v2 by user\n');

    await s.readFile(tc, 'a.txt'); // read again: an equal record
    await s.put(tc, 'a.txt', 'mine\n');
    expect(await s.read('a.txt')).toBe('mine\n');
  });

  it('edit_file: no record → ok; a stale record → refused', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'v1\n');
    await s.seed('b.txt', 'b1\n');
    const tc = s.turn();
    await s.put(tc, 'a.txt', 'v1 edited\n', 'edit_file'); // never read
    expect(await s.read('a.txt')).toBe('v1 edited\n');

    tc.noteRead('b.txt', Buffer.from('b1\n'));
    await fs.writeFile(s.abs('b.txt'), 'b2 by user\n');
    await expect(s.put(tc, 'b.txt', 'b mine\n', 'edit_file')).rejects.toMatchObject({
      code: 'conflict',
      message: autoStaleText('b.txt'),
    });
    expect(await s.read('b.txt')).toBe('b2 by user\n');
  });

  it('delete_file: no record → refused; an equal record → ok; a stale record → refused', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'v1\n');
    await s.seed('b.txt', 'b1\n');
    const tc = s.turn();
    await expect(s.put(tc, 'a.txt', null, 'delete_file')).rejects.toMatchObject({
      code: 'conflict',
      message: autoUnreadText('a.txt'),
    });
    expect(await s.exists('a.txt')).toBe(true);
    await s.readFile(tc, 'a.txt');
    await s.put(tc, 'a.txt', null, 'delete_file');
    expect(await s.exists('a.txt')).toBe(false);

    tc.noteRead('b.txt', Buffer.from('b1\n'));
    await fs.writeFile(s.abs('b.txt'), 'changed\n');
    await expect(s.put(tc, 'b.txt', null, 'delete_file')).rejects.toMatchObject({
      code: 'conflict',
      message: autoStaleText('b.txt'),
    });
    expect(await s.exists('b.txt')).toBe(true);
  });

  it('after the chat’s own write, a second write needs no re-read', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'v1\n');
    const tc = s.turn();
    await s.readFile(tc, 'a.txt');
    await s.put(tc, 'a.txt', 'v2\n');
    await s.put(tc, 'a.txt', 'v3\n'); // write_file, no read in between
    await s.put(s.turn({ turnId: 't2' }), 'a.txt', 'v4\n'); // even in a later turn
    expect(await s.read('a.txt')).toBe('v4\n');
    // A file the chat created is "seen" as well; deleting it needs no read.
    await s.put(tc, 'new.txt', 'n\n');
    await s.put(tc, 'new.txt', null, 'delete_file');
    expect(await s.exists('new.txt')).toBe(false);
  });

  it('a user edit after the chat’s own write makes the next write_file/delete_file refuse', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'v1\n');
    const tc = s.turn();
    await s.readPut(tc, 'a.txt', 'v2\n');
    await fs.writeFile(s.abs('a.txt'), 'user edit\n');
    await expect(s.put(tc, 'a.txt', 'v3\n')).rejects.toMatchObject({ message: autoStaleText('a.txt') });
    await expect(s.put(tc, 'a.txt', null, 'delete_file')).rejects.toMatchObject({ message: autoStaleText('a.txt') });
    expect(await s.read('a.txt')).toBe('user edit\n');
  });

  it('prepareRetry clears the record, even when there is nothing to undo', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'v1\n');
    await s.seed('b.txt', 'b1\n');
    const tc = s.turn();
    await s.readFile(tc, 'b.txt'); // seen, never written by turn t1
    await s.readPut(tc, 'a.txt', 'v2\n');
    // Retry a different turn: nothing to undo for it, but the chat forgets what it has seen.
    expect(await s.retry('other-turn')).toBeNull();
    await expect(s.put(s.turn(), 'a.txt', 'v3\n')).rejects.toMatchObject({ message: autoUnreadText('a.txt') });
    await expect(s.put(s.turn(), 'b.txt', 'b2\n')).rejects.toMatchObject({ message: autoUnreadText('b.txt') });
    await s.readPut(s.turn(), 'b.txt', 'b2\n');
    expect(await s.read('b.txt')).toBe('b2\n');
  });

  it('prepareRetry for the turn undoes it and also clears the record', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'v1\n');
    const tc = s.turn({ turnId: 'tR' });
    await s.readPut(tc, 'a.txt', 'v2\n');
    const res = await s.retry('tR');
    expect(res?.undo).toMatchObject({ by: 'retry', restored: ['a.txt'], skipped: [] });
    expect(await s.read('a.txt')).toBe('v1\n');
    await expect(s.put(s.turn({ turnId: 'tR' }), 'a.txt', 'v3\n')).rejects.toMatchObject({
      message: autoUnreadText('a.txt'),
    });
  });

  it('records are per chat: B’s write makes A’s record stale; A is refused, re-reads, and succeeds', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'v1\n');
    const A = s.turn({ chatId: 'chatA', turnId: 'tA' });
    const B = s.turn({ chatId: 'chatB', turnId: 'tB' });
    await s.readFile(A, 'a.txt');
    // B has not read it: B's record doesn't borrow A's.
    await expect(s.put(B, 'a.txt', 'B1\n')).rejects.toMatchObject({ message: autoUnreadText('a.txt') });
    await s.readFile(B, 'a.txt');
    await s.put(B, 'a.txt', 'B wrote\n');
    await expect(s.put(A, 'a.txt', 'A wrote\n')).rejects.toMatchObject({
      code: 'conflict',
      message: autoStaleText('a.txt'),
    });
    expect(await s.read('a.txt')).toBe('B wrote\n');
    await s.readFile(A, 'a.txt');
    await s.put(A, 'a.txt', 'A wrote\n');
    expect(await s.read('a.txt')).toBe('A wrote\n');
    expect((await s.get('chatA')).applied).toHaveLength(1);
    expect((await s.get('chatB')).applied).toHaveLength(1);
  });

  it(
    'the read record holds at most 1,000 paths per chat; the oldest is dropped first',
    async () => {
      const s = await setupAuto();
      await s.seed('first.txt', 'f\n');
      await s.seed('second.txt', 's\n');
      const tc = s.turn();
      tc.noteRead('first.txt', Buffer.from('f\n'));
      tc.noteRead('second.txt', Buffer.from('s\n'));
      for (let i = 0; i < 997; i++) tc.noteRead(`ghost${i}.txt`, Buffer.from('x'));
      // 999 paths so far: nothing dropped.
      await s.put(tc, 'first.txt', 'f2\n');
      // Re-recording first.txt moved it to the newest; add enough to push second.txt (now oldest) out.
      tc.noteRead('ghost-a.txt', Buffer.from('x'));
      tc.noteRead('ghost-b.txt', Buffer.from('x'));
      await expect(s.put(tc, 'second.txt', 's2\n')).rejects.toMatchObject({ message: autoUnreadText('second.txt') });
      await s.put(tc, 'first.txt', 'f3\n'); // still remembered
    },
    LIMIT_TEST,
  );
});

describe('auto write: pending proposals and modes', () => {
  it('a path with a pending Review proposal is refused; the pending set is unchanged; other paths still write', async () => {
    const s = await setupAuto();
    await s.seed('p.txt', 'base\n');
    await s.seed('q.txt', 'q\n');
    const review = s.turn({ mode: 'review', turnId: 'r1' });
    await review.stage('p.txt', 'proposed\n');
    await review.stage('brand/new.txt', 'proposed new\n');
    const before = await s.get();
    expect(before.pending?.files.map((f) => f.path)).toEqual(['brand/new.txt', 'p.txt']);

    const tc = s.turn({ turnId: 'a1' });
    await s.readFile(tc, 'p.txt');
    for (const tool of ['write_file', 'edit_file', 'delete_file'] as const) {
      await expect(s.put(tc, 'p.txt', tool === 'delete_file' ? null : 'auto\n', tool)).rejects.toMatchObject({
        code: 'conflict',
        message: autoPendingText('p.txt'),
      });
    }
    await expect(s.put(tc, 'brand/new.txt', 'auto new\n')).rejects.toMatchObject({
      message: autoPendingText('brand/new.txt'),
    });
    expect(await s.read('p.txt')).toBe('base\n');
    expect(await s.exists('brand/new.txt')).toBe(false);
    expect(await s.get()).toEqual(before);

    await s.readPut(tc, 'q.txt', 'q auto\n');
    expect(await s.read('q.txt')).toBe('q auto\n');
    const after = await s.get();
    expect(after.pending).toEqual(before.pending);
    expect(after.applied).toHaveLength(1);
  });

  it('the pending check ignores letter case and Unicode form', async () => {
    const s = await setupAuto();
    const review = s.turn({ mode: 'review' });
    await review.stage('Docs/Café.txt', 'proposed\n'); // é composed
    const before = await s.get();
    const tc = s.turn();
    await expect(s.put(tc, 'docs/café.txt', 'x\n')).rejects.toMatchObject({ code: 'conflict' });
    await expect(s.put(tc, 'DOCS/CAFÉ.TXT', 'x\n')).rejects.toMatchObject({ code: 'conflict' });
    expect(await s.get()).toEqual(before);
  });

  it('after the proposal is applied or discarded the path is writable again', async () => {
    const s = await setupAuto();
    await s.seed('p.txt', 'base\n');
    await s.turn({ mode: 'review' }).stage('p.txt', 'proposed\n');
    await s.svc.discard('chat1');
    const tc = s.turn();
    await s.readPut(tc, 'p.txt', 'auto\n');
    expect(await s.read('p.txt')).toBe('auto\n');
  });

  it('stage() in Auto and write() in Review throw; read() and staged() work in both', async () => {
    const s = await setupAuto();
    const auto = s.turn();
    const review = s.turn({ mode: 'review' });
    expect(auto.mode).toBe('auto');
    expect(review.mode).toBe('review');
    await expect(auto.stage('a.txt', 'x\n')).rejects.toThrow();
    await expect(review.write('a.txt', 'x\n', { tool: 'write_file', baseHash: '' })).rejects.toThrow();
    expect(await s.exists('a.txt')).toBe(false);
    expect(await s.get()).toEqual({ pending: null, applied: [], diskSeq: 0 });
    await review.stage('b.txt', 'proposal\n');
    expect(await auto.staged()).toEqual([{ path: 'b.txt', kind: 'create' }]);
    expect(await auto.read('b.txt')).toEqual({ kind: 'staged', content: 'proposal\n' });
  });
});

describe('auto write: failures', () => {
  it('a throw in the hook is a failed write: autoWriteFailedText, nothing recorded, blob collected, lock released', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'v1\n');
    const tc = s.turn();
    await s.readFile(tc, 'a.txt');
    s.hooks.beforeWrite = () => {
      throw new Error('disk on fire');
    };
    await expect(s.put(tc, 'a.txt', 'v2\n')).rejects.toMatchObject({
      code: 'internal',
      message: autoWriteFailedText('a.txt'),
    });
    expect(await s.read('a.txt')).toBe('v1\n');
    expect(await s.get()).toEqual({ pending: null, applied: [], diskSeq: 0 });
    expect(await s.blobs()).toEqual([]);
    // The same file is writable afterwards (the write lock was released), and the record survived the failure.
    s.hooks.beforeWrite = undefined;
    await s.put(tc, 'a.txt', 'v2\n');
    expect(await s.read('a.txt')).toBe('v2\n');
  });

  it('a failed second write leaves the batch as it was after the first', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'v1\n');
    const tc = s.turn();
    await s.readPut(tc, 'a.txt', 'v2\n');
    const before = await s.get();
    s.hooks.beforeWrite = () => {
      throw new Error('nope');
    };
    await expect(s.put(tc, 'a.txt', 'v3\n')).rejects.toMatchObject({ message: autoWriteFailedText('a.txt') });
    await expect(s.put(tc, 'b.txt', 'new\n')).rejects.toMatchObject({ message: autoWriteFailedText('b.txt') });
    expect(await s.get()).toEqual(before);
    expect(await s.read('a.txt')).toBe('v2\n');
    expect(await s.blobs()).toEqual([sha256('v1\n')]);
    // Undo still restores the original.
    s.hooks.beforeWrite = undefined;
    await s.undo(before.applied[0]?.id as string);
    expect(await s.read('a.txt')).toBe('v1\n');
  });

  it('a failure while the unlink/rename target is unwritable does not corrupt the file', async () => {
    if (process.getuid?.() === 0) return; // root ignores permission bits
    const s = await setupAuto();
    await s.seed('ro/a.txt', 'v1\n');
    const tc = s.turn();
    await s.readFile(tc, 'ro/a.txt');
    await fs.chmod(s.abs('ro'), 0o555);
    try {
      await expect(s.put(tc, 'ro/a.txt', 'v2\n')).rejects.toMatchObject({ message: autoWriteFailedText('ro/a.txt') });
    } finally {
      await fs.chmod(s.abs('ro'), 0o755);
    }
    expect(await s.read('ro/a.txt')).toBe('v1\n');
    expect(await fs.readdir(s.abs('ro'))).toEqual(['a.txt']);
    expect((await s.get()).applied).toEqual([]);
    expect(await s.blobs()).toEqual([]);
  });
});

describe('retention', () => {
  /** Turn `i` modifies its own file `f<i>.txt` (original `o<i>`). */
  async function runTurns(s: AutoSetup, from: number, to: number) {
    for (let i = from; i <= to; i++) {
      await s.seed(`f${i}.txt`, `o${i}\n`);
      await s.readPut(s.turn({ turnId: `t${i}`, messageId: `m${i}` }), `f${i}.txt`, `n${i}\n`);
    }
  }

  it(
    '20 turns are all undoable; the 21st drops the oldest turn’s undo data and unreferenced blobs',
    async () => {
      const s = await setupAuto();
      await runTurns(s, 1, 20);
      let { applied } = await s.get();
      expect(applied).toHaveLength(20);
      expect(applied.every((b) => b.undoable)).toBe(true);
      expect(await s.blobs()).toHaveLength(20);

      await runTurns(s, 21, 21);
      applied = (await s.get()).applied;
      expect(applied).toHaveLength(21); // the list still holds all of them
      expect(applied.map((b) => b.undoable)).toEqual([false, ...Array(20).fill(true)]);
      expect(applied[0]?.turnId).toBe('t1');
      expect(applied[0]?.undo).toBeUndefined();
      expect(applied[0]?.written).toHaveLength(1); // the audit trail stays
      const blobs = await s.blobs();
      expect(blobs).toHaveLength(20);
      expect(blobs).not.toContain(sha256('o1\n'));
      expect(blobs).toContain(sha256('o2\n'));
      expect(blobs).toContain(sha256('o21\n'));
      // The dropped batch can't be undone; the file keeps its content.
      await expect(s.undo(applied[0]?.id as string)).rejects.toMatchObject({ code: 'conflict' });
      expect(await s.read('f1.txt')).toBe('n1\n');
      // The store file doesn't keep the dropped data either.
      const stored = await s.readStore();
      expect(stored.applied[0].undoData).toBeUndefined();
    },
    LIMIT_TEST,
  );

  it(
    'a blob still referenced by a newer batch stays',
    async () => {
      const s = await setupAuto();
      // t1 and t21 both start from a file whose original is "same\n": one blob, shared.
      await s.seed('x.txt', 'same\n');
      await s.seed('y.txt', 'uniq\n');
      await s.readPut(s.turn({ turnId: 't1' }), 'x.txt', 'x1\n');
      await s.readPut(s.turn({ turnId: 't1' }), 'y.txt', 'y1\n');
      await runTurns(s, 2, 20);
      await s.seed('z.txt', 'same\n');
      await s.readPut(s.turn({ turnId: 't21' }), 'z.txt', 'z1\n');
      const { applied } = await s.get();
      expect(applied).toHaveLength(21);
      expect(applied[0]?.undoable).toBe(false);
      const blobs = await s.blobs();
      expect(blobs).toContain(sha256('same\n')); // t21 still needs it
      expect(blobs).not.toContain(sha256('uniq\n'));
      expect(blobs).toHaveLength(20); // t2..t20 (19) + t21's "same"
      // t21 restores z.txt from the shared blob.
      const t21 = applied[20];
      await s.undo(t21?.id as string);
      expect(await s.read('z.txt')).toBe('same\n');
    },
    LIMIT_TEST,
  );

  it(
    'review batches do not count against the 20 turns',
    async () => {
      const s = await setupAuto();
      await runTurns(s, 1, 20);
      for (let i = 0; i < 5; i++) {
        await s.seed(`r${i}.txt`, 'r\n');
        await s.turn({ mode: 'review', turnId: `rv${i}` }).stage(`r${i}.txt`, 'r2\n');
        const p = (await s.get()).pending;
        const decisions: Record<string, Record<string, HunkDecision>> = {};
        for (const f of p?.files ?? []) decisions[f.path] = Object.fromEntries(f.hunks.map((h) => [h.id, 'accepted']));
        await s.svc.apply({ chatId: 'chat1', projectRoot: s.root, revision: p?.revision ?? 0, decisions });
      }
      const { applied } = await s.get();
      expect(applied).toHaveLength(25);
      expect(applied.filter((b) => b.source === 'auto').every((b) => b.undoable)).toBe(true);
      expect(applied.filter((b) => b.source === 'review').every((b) => !b.undoable)).toBe(true);
    },
    LIMIT_TEST,
  );

  it('the list is capped at 100 batches for both sources; only 20 keep blobs', async () => {
    const s = await setupAuto();
    await runTurns(s, 1, 101);
    const { applied } = await s.get();
    expect(applied).toHaveLength(100);
    expect(applied[0]?.turnId).toBe('t2');
    expect(applied.filter((b) => b.undoable)).toHaveLength(20);
    expect(await s.blobs()).toHaveLength(20);
  }, 120_000);

  it('undoing a turn frees its blobs; an undone batch no longer counts as holding data', async () => {
    const s = await setupAuto();
    await runTurns(s, 1, 3);
    const { applied } = await s.get();
    await s.undo(applied[1]?.id as string);
    expect(await s.blobs()).toEqual([sha256('o1\n'), sha256('o3\n')].sort());
  });
});

describe('concurrency (deterministic, via the hook)', () => {
  it(
    'two chats write the same file at once: B blocks on the lock, then is refused as stale',
    async () => {
      const s = await setupAuto();
      await s.seed('a.txt', 'v1\n');
      const A = s.turn({ chatId: 'chatA', turnId: 'tA' });
      const B = s.turn({ chatId: 'chatB', turnId: 'tB' });
      await s.readFile(A, 'a.txt');
      await s.readFile(B, 'a.txt');
      const baseHash = await s.hashNow('a.txt');
      const g = gate();
      const order: string[] = [];
      s.hooks.beforeWrite = async (info) => {
        order.push(`hook:${info.chatId}`);
        if (info.chatId === 'chatA') await g.hold();
      };
      const pa = A.write('a.txt', 'from A\n', { tool: 'write_file', baseHash });
      await g.entered; // A holds the file's lock
      let bSettled = false;
      const pb = B.write('a.txt', 'from B\n', { tool: 'write_file', baseHash }).finally(() => {
        bSettled = true;
      });
      pb.catch(() => {});
      await flush();
      expect(bSettled).toBe(false);
      expect(order).toEqual(['hook:chatA']); // B never got into the critical section
      g.open();
      const [ra, rb] = await Promise.allSettled([pa, pb]);
      expect(ra.status).toBe('fulfilled');
      expect(rb.status).toBe('rejected');
      expect((rb as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict', message: autoStaleText('a.txt') });
      expect(await s.read('a.txt')).toBe('from A\n');
      expect((await s.get('chatA')).applied).toHaveLength(1);
      expect((await s.get('chatB')).applied).toEqual([]);
      expect((await s.get('chatB')).diskSeq).toBe(0);
      expect(await s.blobs('chatB')).toEqual([]);
    },
    LIMIT_TEST,
  );

  it(
    'two chats create the same new file at once: exactly one create lands',
    async () => {
      const s = await setupAuto();
      const A = s.turn({ chatId: 'chatA', turnId: 'tA' });
      const B = s.turn({ chatId: 'chatB', turnId: 'tB' });
      const results = await Promise.allSettled([
        A.write('new.txt', 'A\n', { tool: 'write_file', baseHash: '' }),
        B.write('new.txt', 'B\n', { tool: 'write_file', baseHash: '' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'conflict', message: autoStaleText('new.txt') });
      const winner = results[0]?.status === 'fulfilled' ? 'A\n' : 'B\n';
      expect(await s.read('new.txt')).toBe(winner);
      const applied = [...(await s.get('chatA')).applied, ...(await s.get('chatB')).applied];
      expect(applied).toHaveLength(1);
    },
    LIMIT_TEST,
  );

  it(
    'many chats racing for one file: exactly one write lands',
    async () => {
      const s = await setupAuto();
      await s.seed('a.txt', 'v1\n');
      const base = await s.hashNow('a.txt');
      const chats = Array.from({ length: 8 }, (_, i) => `c${i}`);
      for (const c of chats) await s.readFile(s.turn({ chatId: c }), 'a.txt');
      const results = await Promise.allSettled(
        chats.map((c) => s.turn({ chatId: c }).write('a.txt', `from ${c}\n`, { tool: 'write_file', baseHash: base })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const winner = chats[results.findIndex((r) => r.status === 'fulfilled')];
      expect(await s.read('a.txt')).toBe(`from ${winner}\n`);
    },
    LIMIT_TEST,
  );

  it(
    'review apply in chat A holds the lock; chat B’s auto write waits and is then refused; never both written',
    async () => {
      const s = await setupAuto();
      await s.seed('f.txt', 'base\n');
      await s.turn({ chatId: 'chatA', mode: 'review' }).stage('f.txt', 'from review\n');
      const B = s.turn({ chatId: 'chatB', turnId: 'tB' });
      await s.readFile(B, 'f.txt');
      const baseHash = await s.hashNow('f.txt');
      const p = (await s.get('chatA')).pending;
      const decisions = {
        'f.txt': Object.fromEntries((p?.files[0]?.hunks ?? []).map((h) => [h.id, 'accepted' as const])),
      };
      const g = gate();
      const order: string[] = [];
      s.hooks.beforeWrite = async (info) => {
        order.push(`${info.op}:${info.chatId}`);
        if (info.op === 'apply') await g.hold();
      };
      const applying = s.svc.apply({ chatId: 'chatA', projectRoot: s.root, revision: p?.revision ?? 0, decisions });
      await g.entered;
      let bSettled = false;
      const pb = B.write('f.txt', 'from auto\n', { tool: 'write_file', baseHash }).finally(() => {
        bSettled = true;
      });
      pb.catch(() => {});
      await flush();
      expect(bSettled).toBe(false);
      expect(order).toEqual(['apply:chatA']);
      g.open();
      const res = await applying;
      await expect(pb).rejects.toMatchObject({ code: 'conflict', message: autoStaleText('f.txt') });
      expect(res.batch.written.map((f) => f.path)).toEqual(['f.txt']);
      expect(await s.read('f.txt')).toBe('from review\n');
      expect((await s.get('chatB')).applied).toEqual([]);
    },
    LIMIT_TEST,
  );

  it(
    'an auto write in chat B holds the lock; chat A’s review apply waits and reports changed_on_disk',
    async () => {
      const s = await setupAuto();
      await s.seed('f.txt', 'base\n');
      await s.turn({ chatId: 'chatA', mode: 'review' }).stage('f.txt', 'from review\n');
      const B = s.turn({ chatId: 'chatB', turnId: 'tB' });
      await s.readFile(B, 'f.txt');
      const g = gate();
      const order: string[] = [];
      s.hooks.beforeWrite = async (info) => {
        order.push(`${info.op}:${info.chatId}`);
        if (info.op === 'auto') await g.hold();
      };
      const pb = s.put(B, 'f.txt', 'from auto\n');
      await g.entered;
      const p = (await s.get('chatA')).pending;
      const decisions = {
        'f.txt': Object.fromEntries((p?.files[0]?.hunks ?? []).map((h) => [h.id, 'accepted' as const])),
      };
      let applied = false;
      const applying = s.svc
        .apply({ chatId: 'chatA', projectRoot: s.root, revision: p?.revision ?? 0, decisions })
        .finally(() => {
          applied = true;
        });
      await flush();
      expect(applied).toBe(false);
      expect(order).toEqual(['auto:chatB']);
      g.open();
      await pb;
      const res = await applying;
      expect(res.batch.conflicts).toEqual([{ path: 'f.txt', reason: 'changed_on_disk' }]);
      expect(res.batch.written).toEqual([]);
      expect(await s.read('f.txt')).toBe('from auto\n');
      expect(res.changes.diskSeq).toBe(0); // the apply wrote nothing
      expect((await s.get('chatB')).diskSeq).toBe(1);
    },
    LIMIT_TEST,
  );

  it(
    'review apply creating a file races an auto create of the same path: one wins, the other is reported',
    async () => {
      const s = await setupAuto();
      await s.turn({ chatId: 'chatA', mode: 'review' }).stage('new.txt', 'review\n');
      const p = (await s.get('chatA')).pending;
      const decisions = {
        'new.txt': Object.fromEntries((p?.files[0]?.hunks ?? []).map((h) => [h.id, 'accepted' as const])),
      };
      const B = s.turn({ chatId: 'chatB' });
      const [applyRes, autoRes] = await Promise.allSettled([
        s.svc.apply({ chatId: 'chatA', projectRoot: s.root, revision: p?.revision ?? 0, decisions }),
        B.write('new.txt', 'auto\n', { tool: 'write_file', baseHash: '' }),
      ]);
      const applyWrote = applyRes.status === 'fulfilled' && applyRes.value.batch.written.length === 1;
      const autoWrote = autoRes.status === 'fulfilled';
      expect([applyWrote, autoWrote].filter(Boolean)).toHaveLength(1);
      if (applyWrote) expect(await s.read('new.txt')).toBe('review\n');
      else {
        expect(await s.read('new.txt')).toBe('auto\n');
        expect(applyRes.status === 'fulfilled' && applyRes.value.batch.conflicts).toEqual([
          { path: 'new.txt', reason: 'exists_on_disk' },
        ]);
      }
    },
    LIMIT_TEST,
  );

  it(
    'undo in chat A while chats B and C write overlapping files: completes, every file restored or reported',
    async () => {
      const s = await setupAuto();
      for (const f of ['f1', 'f2', 'f3']) await s.seed(`${f}.txt`, `${f} orig\n`);
      const A = s.turn({ chatId: 'chatA', turnId: 'tA' });
      for (const f of ['f1', 'f2', 'f3']) await s.readPut(A, `${f}.txt`, `${f} by A\n`);
      const batchId = (await s.get('chatA')).applied[0]?.id as string;
      const B = s.turn({ chatId: 'chatB', turnId: 'tB' });
      const C = s.turn({ chatId: 'chatC', turnId: 'tC' });
      for (const f of ['f1', 'f2', 'f3']) {
        await s.readFile(B, `${f}.txt`);
        await s.readFile(C, `${f}.txt`);
      }
      const baseF1 = await s.hashNow('f1.txt');

      const g = gate();
      s.hooks.beforeWrite = async (info) => {
        if (info.op === 'undo' && info.path === 'f1.txt') await g.hold();
      };
      const undoing = s.undo(batchId, { chatId: 'chatA' });
      await g.entered; // A's undo holds f1's write lock (and A's store lock)
      // C wants f1 (blocked on the lock); B writes f2 (a different lock: proceeds at once).
      let cSettled = false;
      const cF1 = C.write('f1.txt', 'f1 by C\n', { tool: 'write_file', baseHash: baseF1 }).finally(() => {
        cSettled = true;
      });
      cF1.catch(() => {});
      await s.put(B, 'f2.txt', 'f2 by B\n');
      await flush();
      expect(cSettled).toBe(false);
      g.open();
      const res = await undoing;
      await expect(cF1).rejects.toMatchObject({ code: 'conflict' }); // f1 was restored under it: stale

      expect(res.batch.undo?.restored).toEqual(['f1.txt', 'f3.txt']);
      expect(res.batch.undo?.skipped).toEqual([{ path: 'f2.txt', reason: 'changed_since' }]);
      expect(await s.read('f1.txt')).toBe('f1 orig\n');
      expect(await s.read('f2.txt')).toBe('f2 by B\n');
      expect(await s.read('f3.txt')).toBe('f3 orig\n');
    },
    LIMIT_TEST,
  );

  it(
    'B holds a file A’s undo needs: A waits, then reports it as changed; no deadlock',
    async () => {
      const s = await setupAuto();
      for (const f of ['f1', 'f2']) await s.seed(`${f}.txt`, `${f} orig\n`);
      const A = s.turn({ chatId: 'chatA', turnId: 'tA' });
      for (const f of ['f1', 'f2']) await s.readPut(A, `${f}.txt`, `${f} by A\n`);
      const batchId = (await s.get('chatA')).applied[0]?.id as string;
      const B = s.turn({ chatId: 'chatB', turnId: 'tB' });
      await s.readFile(B, 'f2.txt');
      const baseF2 = await s.hashNow('f2.txt');

      const g = gate();
      s.hooks.beforeWrite = async (info) => {
        if (info.op === 'auto' && info.chatId === 'chatB') await g.hold();
      };
      const bWrite = B.write('f2.txt', 'f2 by B\n', { tool: 'write_file', baseHash: baseF2 });
      await g.entered; // B holds f2's lock and B's store lock
      let undone = false;
      const undoing = s.undo(batchId, { chatId: 'chatA' }).finally(() => {
        undone = true;
      });
      // A restores f1 (a free lock), then waits on f2's.
      await waitFor(async () => (await s.read('f1.txt')) === 'f1 orig\n');
      await flush();
      expect(undone).toBe(false);
      g.open();
      const [, res] = await Promise.all([bWrite, undoing]);
      expect(res.batch.undo?.restored).toEqual(['f1.txt']);
      expect(res.batch.undo?.skipped).toEqual([{ path: 'f2.txt', reason: 'changed_since' }]);
      expect(await s.read('f2.txt')).toBe('f2 by B\n');
    },
    LIMIT_TEST,
  );

  it(
    'two undos of the same batch at once: one wins, the other is a conflict',
    async () => {
      const s = await setupAuto();
      await s.seed('a.txt', 'orig\n');
      await s.readPut(s.turn(), 'a.txt', 'new\n');
      const id = (await s.get()).applied[0]?.id as string;
      const results = await Promise.allSettled([s.undo(id), s.undo(id)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
        code: 'conflict',
      });
      expect(await s.read('a.txt')).toBe('orig\n');
    },
    LIMIT_TEST,
  );

  it.runIf(process.platform === 'darwin')(
    'two chats create "poſt.txt" and "post.txt" at once: one lock, exactly one create lands',
    async (ctx) => {
      const s = await setupAuto();
      // The volume must store the two spellings as one name (APFS and HFS+ do by default).
      await fs.writeFile(path.join(s.outside, 'post.txt'), 'probe');
      if (
        !(await fs.lstat(path.join(s.outside, 'poſt.txt')).then(
          () => true,
          () => false,
        ))
      ) {
        ctx.skip();
      }
      const A = s.turn({ chatId: 'chatA', turnId: 'tA' });
      const B = s.turn({ chatId: 'chatB', turnId: 'tB' });
      const g = gate();
      const order: string[] = [];
      s.hooks.beforeWrite = async (info) => {
        order.push(info.chatId);
        if (info.chatId === 'chatA') await g.hold();
      };
      const pa = A.write('poſt.txt', 'A\n', { tool: 'write_file', baseHash: '' });
      await g.entered;
      let bSettled = false;
      const pb = B.write('post.txt', 'B\n', { tool: 'write_file', baseHash: '' }).finally(() => {
        bSettled = true;
      });
      pb.catch(() => {});
      await flush(64);
      expect(bSettled).toBe(false);
      expect(order).toEqual(['chatA']); // B waits on A's lock instead of passing its own checks
      g.open();
      const [ra, rb] = await Promise.allSettled([pa, pb]);
      expect(ra.status).toBe('fulfilled');
      expect((rb as PromiseRejectedResult).reason).toMatchObject({
        code: 'conflict',
        message: autoStaleText('post.txt'),
      });
      expect(await fs.readdir(s.root)).toHaveLength(1);
      expect(await s.read('post.txt')).toBe('A\n');
      expect([...(await s.get('chatA')).applied, ...(await s.get('chatB')).applied]).toHaveLength(1);
    },
    LIMIT_TEST,
  );

  it('two paths differing only by case or Unicode form (or reached through a link) share one lock key', async () => {
    const s = await setupAuto();
    const key = (rel: string) => fileLockKey(s.abs(rel));
    expect(await key('Dir/File.TXT')).toBe(await key('dir/file.txt'));
    expect(await key('café.txt')).toBe(await key('café.txt'));
    expect(await key('a.txt')).not.toBe(await key('b.txt'));
    await s.seed('real/x.txt', 'x\n');
    await fs.symlink(s.abs('real'), s.abs('alias'));
    expect(await key('alias/x.txt')).toBe(await key('real/x.txt'));
    expect(await key('alias/not-yet.txt')).toBe(await key('real/not-yet.txt'));
  });

  it(
    'a write to "Case.txt" holds the lock that "case.txt" needs',
    async () => {
      const s = await setupAuto();
      const A = s.turn({ chatId: 'chatA' });
      const B = s.turn({ chatId: 'chatB' });
      const g = gate();
      const order: string[] = [];
      s.hooks.beforeWrite = async (info) => {
        order.push(info.chatId);
        if (info.chatId === 'chatA') await g.hold();
      };
      const pa = A.write('Case.txt', 'A\n', { tool: 'write_file', baseHash: '' });
      await g.entered;
      let bSettled = false;
      const pb = B.write('case.txt', 'B\n', { tool: 'write_file', baseHash: '' }).finally(() => {
        bSettled = true;
      });
      pb.catch(() => {});
      await flush();
      expect(bSettled).toBe(false);
      expect(order).toEqual(['chatA']);
      g.open();
      await pa;
      await pb.catch(() => {}); // a case-insensitive disk refuses it; a case-sensitive one writes a second file
      expect(await s.read('Case.txt')).toBe('A\n');
    },
    LIMIT_TEST,
  );

  it(
    'removeForChat waits for an in-flight write, then leaves neither store nor blobs behind',
    async () => {
      const s = await setupAuto();
      await s.seed('a.txt', 'orig\n');
      const tc = s.turn();
      await s.readFile(tc, 'a.txt');
      const baseHash = await s.hashNow('a.txt');
      const g = gate();
      s.hooks.beforeWrite = () => g.hold();
      const writing = tc.write('a.txt', 'new\n', { tool: 'write_file', baseHash });
      await g.entered;
      let removed = false;
      const removing = s.svc.removeForChat('chat1').then(() => {
        removed = true;
      });
      await flush();
      expect(removed).toBe(false);
      g.open();
      await writing;
      await removing;
      expect(await fs.stat(s.storeFile()).catch(() => null)).toBeNull();
      expect(await fs.stat(s.blobDir()).catch(() => null)).toBeNull();
    },
    LIMIT_TEST,
  );
});

describe('prepareRetry and later writes of the same turn id', () => {
  it('writes after a retry open a new batch for the same turn id; a second retry undoes only that one', async () => {
    const s = await setupAuto();
    await s.seed('a.txt', 'orig\n');
    const first = await s.readPut(s.turn({ turnId: 'T' }), 'a.txt', 'attempt 1\n');
    const r1 = await s.retry('T');
    expect(r1?.batchId).toBe(first.batchId);
    expect(await s.read('a.txt')).toBe('orig\n');
    const second = await s.readPut(s.turn({ turnId: 'T' }), 'a.txt', 'attempt 2\n');
    expect(second.batchId).not.toBe(first.batchId);
    const { applied } = await s.get();
    expect(applied.map((b) => [b.id === first.batchId, b.undoable])).toEqual([
      [true, false],
      [false, true],
    ]);
    const r2 = await s.retry('T');
    expect(r2?.batchId).toBe(second.batchId);
    expect(await s.read('a.txt')).toBe('orig\n');
    expect(await s.retry('T')).toBeNull();
  });
});
