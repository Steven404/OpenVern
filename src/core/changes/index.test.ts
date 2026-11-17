import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import type { DiffHunk, FileChange, HunkDecision } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { sampleProposal } from '../../renderer/lib/mock-changes';
import { modeChangedNote, tooLargeToReviewText } from '../agent/edit-mode';
import { ensureDataDir } from '../storage/paths';
import { cleanupTempDirs, makeTempDir } from '../storage/test-helpers';
import { sha256 } from './blobs';
import { createChangesService } from './index';

cleanupTempDirs();

const CHAT = 'chat1';
const MSG = 'msg1';

async function setup() {
  const base = await makeTempDir();
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  const dataDir = (await ensureDataDir(path.join(base, 'data'))).root;
  const realRoot = await fs.realpath(root);
  const svc = createChangesService({ dataDir });
  const tools = (messageId = MSG) =>
    svc.tools({ chatId: CHAT, projectId: 'p', projectRoot: realRoot, messageId, turnId: 'u', mode: 'review' });
  const write = async (rel: string, text: string | Buffer) => {
    await fs.mkdir(path.dirname(path.join(realRoot, rel)), { recursive: true });
    await fs.writeFile(path.join(realRoot, rel), text);
  };
  const read = (rel: string) => fs.readFile(path.join(realRoot, rel), 'utf8');
  const exists = (rel: string) =>
    fs.lstat(path.join(realRoot, rel)).then(
      () => true,
      () => false,
    );
  const apply = async (revision: number, decisions: Record<string, Record<string, HunkDecision>>) =>
    svc.apply({ chatId: CHAT, projectRoot: realRoot, revision, decisions });
  const pending = async () => (await svc.get(CHAT)).pending;
  const allOf = async (decision: HunkDecision) => {
    const p = await pending();
    return Object.fromEntries(
      (p?.files ?? []).map((f) => [f.path, Object.fromEntries(f.hunks.map((h) => [h.id, decision]))]),
    );
  };
  return { svc, tools, write, read, exists, apply, pending, allOf, root: realRoot, dataDir };
}

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const hunkIds = (f: FileChange | undefined) => (f?.hunks ?? []).map((h: DiffHunk) => h.id);

describe('staging', () => {
  it('creates, modifies and deletes (kinds, counts, sorted paths)', async () => {
    const s = await setup();
    await s.write('b.txt', 'one\ntwo\nthree\n');
    await s.write('c.txt', 'bye\n');
    const t = s.tools();
    await t.stage('b.txt', 'one\nTWO\nthree\n');
    await t.stage('a/new.txt', 'hello\nworld\n');
    const r = await t.stage('c.txt', null);
    expect(r.summary?.files).toEqual([
      { path: 'a/new.txt', kind: 'create', add: 2, del: 0 },
      { path: 'b.txt', kind: 'modify', add: 1, del: 1 },
      { path: 'c.txt', kind: 'delete', add: 0, del: 1 },
    ]);
    expect(r.summary?.totalAdd).toBe(3);
    expect(await s.exists('a/new.txt')).toBe(false); // nothing on disk yet
    expect(await s.read('b.txt')).toBe('one\ntwo\nthree\n');
    expect(await t.staged()).toEqual([
      { path: 'a/new.txt', kind: 'create' },
      { path: 'b.txt', kind: 'modify' },
      { path: 'c.txt', kind: 'delete' },
    ]);
    expect(await t.read('b.txt')).toEqual({ kind: 'staged', content: 'one\nTWO\nthree\n' });
    expect(await t.read('c.txt')).toEqual({ kind: 'deleted' });
    expect(await t.read('other.txt')).toBeNull();

    const p = await s.pending();
    const res = await s.apply(p?.revision ?? -1, await s.allOf('accepted'));
    expect(res.batch.written.map((f) => f.path)).toEqual(['a/new.txt', 'b.txt', 'c.txt']);
    expect(await s.read('a/new.txt')).toBe('hello\nworld\n');
    expect(await s.read('b.txt')).toBe('one\nTWO\nthree\n');
    expect(await s.exists('c.txt')).toBe(false);
    expect(res.changes.pending).toBeNull();
    expect(res.changes.applied).toHaveLength(1);
  });

  it('stages the same file twice, keeping the first base and bumping the revision', async () => {
    const s = await setup();
    await s.write('f.txt', 'a\nb\nc\n');
    const t = s.tools();
    const r1 = await t.stage('f.txt', 'a\nB\nc\n');
    const r2 = await t.stage('f.txt', 'a\nB\nC\n');
    expect(r2.summary?.revision).toBeGreaterThan(r1.summary?.revision ?? 0);
    expect(r2.file?.add).toBe(2);
    expect(r2.file?.del).toBe(2);
    expect(await t.read('f.txt')).toEqual({ kind: 'staged', content: 'a\nB\nC\n' });
  });

  it('collapses no-ops: back to the base, created then deleted', async () => {
    const s = await setup();
    await s.write('f.txt', 'a\nb\n');
    const t = s.tools();
    await t.stage('f.txt', 'a\nX\n');
    const back = await t.stage('f.txt', 'a\nb\n');
    expect(back.summary).toBeNull();
    expect(back.file).toBeNull();
    await t.stage('n.txt', 'new\n');
    const gone = await t.stage('n.txt', null);
    expect(gone.summary).toBeNull();
    expect(await s.pending()).toBeNull();
    // Writing identical content to an untouched file stages nothing.
    expect((await t.stage('f.txt', 'a\nb\n')).summary).toBeNull();
  });

  it('refuses denied and escaping paths, placeholders, binary overwrites, big content, missing deletes', async () => {
    const s = await setup();
    await s.write('bin.dat', Buffer.from([1, 2, 0, 3]));
    await s.write('.env', 'K=1\n');
    const t = s.tools();
    await expect(t.stage('.env', 'x\n')).rejects.toMatchObject({ code: 'path_invalid' });
    await expect(t.stage('.git/config', 'x\n')).rejects.toMatchObject({ code: 'path_invalid' });
    await expect(t.stage('../out.txt', 'x\n')).rejects.toMatchObject({ code: 'path_invalid' });
    await expect(t.stage('a.txt', 'key «redacted:openrouter»\n')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t.stage('bin.dat', 'text')).rejects.toMatchObject({ code: 'unsupported_file' });
    await expect(t.stage('big.txt', 'x'.repeat(LIMITS.writeFileMaxBytes + 1))).rejects.toMatchObject({
      code: 'file_too_large',
    });
    await expect(t.stage('missing.txt', null)).rejects.toMatchObject({ code: 'not_found' });
    // Deleting a binary file is allowed.
    const r = await t.stage('bin.dat', null);
    expect(r.summary?.files).toEqual([{ path: 'bin.dat', kind: 'delete', add: 0, del: 0 }]);
    expect(await s.pending()).not.toBeNull();
  });

  it('refuses a new file below a symlinked directory and caps the number of files', async () => {
    const s = await setup();
    const outside = await makeTempDir();
    await fs.symlink(outside, path.join(s.root, 'link'));
    const t = s.tools();
    await expect(t.stage('link/new.txt', 'x\n')).rejects.toMatchObject({ code: 'path_invalid' });
    for (let i = 0; i < LIMITS.pendingFilesPerChat; i++) await t.stage(`f${i}.txt`, 'x\n');
    await expect(t.stage('one-more.txt', 'x\n')).rejects.toMatchObject({ code: 'conflict' });
    await t.stage('f0.txt', 'y\n'); // an already staged file is still editable
  });
});

describe('apply', () => {
  it('applies 1 of 2 hunks and produces the exact expected bytes', async () => {
    const s = await setup();
    const base = lines(30);
    await s.write('f.txt', `${base.join('\n')}\n`);
    const next = [...base];
    next[1] = 'line 2 CHANGED';
    next[27] = 'line 28 CHANGED';
    await s.tools().stage('f.txt', `${next.join('\n')}\n`);
    const p = await s.pending();
    const file = p?.files[0];
    expect(file?.hunks).toHaveLength(2);
    const [h1, h2] = (file?.hunks ?? []) as DiffHunk[];
    const res = await s.apply(p?.revision ?? 0, {
      'f.txt': { [h1?.id as string]: 'rejected', [h2?.id as string]: 'accepted' },
    });
    const expected = [...base];
    expected[27] = 'line 28 CHANGED';
    expect(await s.read('f.txt')).toBe(`${expected.join('\n')}\n`);
    expect(res.batch.rejectedHunks).toBe(1);
    expect(res.batch.skippedHunks).toBe(0);
    expect(res.batch.written[0]?.hunks).toHaveLength(1);
    expect(res.batch.written[0]?.add).toBe(1);
  });

  it('leaves undecided hunks out', async () => {
    const s = await setup();
    const base = lines(30);
    await s.write('f.txt', `${base.join('\n')}\n`);
    const next = [...base];
    next[1] = 'X';
    next[27] = 'Y';
    await s.tools().stage('f.txt', `${next.join('\n')}\n`);
    const p = await s.pending();
    const [h1] = (p?.files[0]?.hunks ?? []) as DiffHunk[];
    const res = await s.apply(p?.revision ?? 0, { 'f.txt': { [h1?.id as string]: 'accepted' } });
    expect(res.batch.skippedHunks).toBe(1);
    const expected = [...base];
    expected[1] = 'X';
    expect(await s.read('f.txt')).toBe(`${expected.join('\n')}\n`);
  });

  it('keeps CRLF endings and a missing final newline', async () => {
    const s = await setup();
    await s.write('crlf.txt', 'a\r\nb\r\nc\r\n');
    await s.write('nonl.txt', 'a\nb\nc');
    const t = s.tools();
    await t.stage('crlf.txt', 'a\nB\nc\nd\n'); // model wrote LF
    await t.stage('nonl.txt', 'a\nb\nc\nd\n'); // appended, with a final newline
    const p = await s.pending();
    expect(p?.files.map((f) => [f.path, f.add, f.del])).toEqual([
      ['crlf.txt', 2, 1],
      ['nonl.txt', 1, 0],
    ]);
    await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    expect(await s.read('crlf.txt')).toBe('a\r\nB\r\nc\r\nd\r\n');
    expect(await s.read('nonl.txt')).toBe('a\nb\nc\nd');
  });

  it('ignores line-ending-only differences', async () => {
    const s = await setup();
    await s.write('crlf.txt', 'a\r\nb\r\n');
    const r = await s.tools().stage('crlf.txt', 'a\nb\n');
    expect(r.summary).toBeNull();
  });

  it('keeps the file mode', async () => {
    const s = await setup();
    await s.write('run.sh', '#!/bin/sh\necho 1\n');
    await fs.chmod(path.join(s.root, 'run.sh'), 0o755);
    await s.tools().stage('run.sh', '#!/bin/sh\necho 2\n');
    const p = await s.pending();
    await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    expect((await fs.stat(path.join(s.root, 'run.sh'))).mode & 0o777).toBe(0o755);
    expect(await s.read('run.sh')).toBe('#!/bin/sh\necho 2\n');
  });

  it('refuses a stale revision', async () => {
    const s = await setup();
    await s.tools().stage('a.txt', 'x\n');
    const p = await s.pending();
    await s.tools().stage('b.txt', 'y\n');
    await expect(s.apply(p?.revision ?? 0, await s.allOf('accepted'))).rejects.toMatchObject({ code: 'changes_stale' });
    expect(await s.exists('a.txt')).toBe(false);
  });

  it('reports each conflict reason and writes the rest', async () => {
    const s = await setup();
    await s.write('changed.txt', 'a\n');
    await s.write('gone.txt', 'a\n');
    await s.write('del.txt', 'a\n');
    await s.write('ok.txt', 'a\n');
    await s.write('swap.txt', 'a\n');
    const t = s.tools();
    await t.stage('changed.txt', 'b\n');
    await t.stage('gone.txt', 'b\n');
    await t.stage('del.txt', null);
    await t.stage('exists.txt', 'new\n');
    await t.stage('ok.txt', 'b\n');
    await t.stage('swap.txt', 'b\n');
    // Outside changes after proposing.
    await s.write('changed.txt', 'outside\n');
    await fs.rm(path.join(s.root, 'gone.txt'));
    await s.write('del.txt', 'edited\n');
    await s.write('exists.txt', 'someone else\n');
    const outside = await makeTempDir();
    await fs.writeFile(path.join(outside, 'target.txt'), 'a\n');
    await fs.rm(path.join(s.root, 'swap.txt'));
    await fs.symlink(path.join(outside, 'target.txt'), path.join(s.root, 'swap.txt'));

    const p = await s.pending();
    const res = await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    const reasons = Object.fromEntries(res.batch.conflicts.map((c) => [c.path, c.reason]));
    expect(reasons).toEqual({
      'changed.txt': 'changed_on_disk',
      'gone.txt': 'deleted_on_disk',
      'del.txt': 'changed_on_disk',
      'exists.txt': 'exists_on_disk',
      'swap.txt': 'blocked',
    });
    expect(res.batch.written.map((f) => f.path)).toEqual(['ok.txt']);
    expect(await s.read('ok.txt')).toBe('b\n');
    expect(await s.read('changed.txt')).toBe('outside\n');
    expect(await s.read('del.txt')).toBe('edited\n');
    expect(await fs.readFile(path.join(outside, 'target.txt'), 'utf8')).toBe('a\n');
    expect((await s.pending()) ?? null).toBeNull();
  });

  it('blocks a directory swapped for a symlink after staging a new file', async () => {
    const s = await setup();
    await s.tools().stage('dir/new.txt', 'x\n');
    const outside = await makeTempDir();
    await fs.symlink(outside, path.join(s.root, 'dir'));
    const p = await s.pending();
    const res = await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    expect(res.batch.conflicts).toEqual([{ path: 'dir/new.txt', reason: 'blocked' }]);
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

describe('discard, snapshot/restore, notes, cleanup', () => {
  it('discards and notes it', async () => {
    const s = await setup();
    await s.tools().stage('a.txt', 'x\n');
    const r = await s.svc.discard(CHAT);
    expect(r.pending).toBeNull();
    expect(await s.exists('a.txt')).toBe(false);
    expect(await s.svc.takeNote(CHAT, { mode: 'review', firstTurn: false })).toBe(
      '[OpenVern] Since your last reply the user reviewed your proposed edits:\n- Discarded: a.txt (new file, not created)\nNothing else is pending.',
    );
    expect(await s.svc.takeNote(CHAT, { mode: 'review', firstTurn: false })).toBeUndefined();
  });

  it('restores the snapshot taken for a user message', async () => {
    const s = await setup();
    await s.write('f.txt', 'a\n');
    await s.tools().stage('f.txt', 'b\n');
    await s.svc.snapshot(CHAT, 'u2');
    await s.tools('msg2').stage('g.txt', 'new\n');
    await s.tools('msg2').stage('f.txt', 'c\n');
    const before = await s.pending();
    await s.svc.restore(CHAT, 'u2');
    const after = await s.pending();
    expect(after?.files.map((f) => f.path)).toEqual(['f.txt']);
    expect(await s.tools().read('f.txt')).toEqual({ kind: 'staged', content: 'b\n' });
    expect(after?.messageId).toBe(MSG);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    // A snapshot of an empty set restores to empty.
    await s.svc.discard(CHAT);
    await s.svc.snapshot(CHAT, 'u3');
    await s.tools().stage('h.txt', 'z\n');
    await s.svc.restore(CHAT, 'u3');
    expect(await s.pending()).toBeNull();
  });

  it('writes the note from the spec after an apply', async () => {
    const s = await setup();
    const a = lines(30);
    await s.write('multi.txt', `${a.join('\n')}\n`);
    await s.write('rej.txt', 'a\n');
    await s.write('conf.txt', 'a\n');
    await s.write('skip.txt', 'a\n');
    const t = s.tools();
    const m = [...a];
    m[1] = 'X';
    m[27] = 'Y';
    await t.stage('multi.txt', `${m.join('\n')}\n`);
    await t.stage('rej.txt', 'b\n');
    await t.stage('conf.txt', 'b\n');
    await t.stage('skip.txt', 'b\n');
    await t.stage('newfile.txt', 'n\n');
    await s.write('conf.txt', 'changed\n');
    const p = await s.pending();
    const byPath = Object.fromEntries((p?.files ?? []).map((f) => [f.path, f]));
    const res = await s.apply(p?.revision ?? 0, {
      'multi.txt': Object.fromEntries(hunkIds(byPath['multi.txt']).map((id) => [id, 'accepted' as const])),
      'rej.txt': Object.fromEntries(hunkIds(byPath['rej.txt']).map((id) => [id, 'rejected' as const])),
      'conf.txt': Object.fromEntries(hunkIds(byPath['conf.txt']).map((id) => [id, 'accepted' as const])),
      'newfile.txt': Object.fromEntries(hunkIds(byPath['newfile.txt']).map((id) => [id, 'accepted' as const])),
    });
    expect(res.batch.skippedHunks).toBe(1);
    expect(await s.svc.takeNote(CHAT, { mode: 'review', firstTurn: false })).toBe(
      [
        '[OpenVern] Since your last reply the user reviewed your proposed edits:',
        '- Written: multi.txt (2 of 2 changes), newfile.txt (1 of 1)',
        '- Rejected: rej.txt (not changed)',
        '- Left out, not decided: skip.txt (not changed)',
        '- Not written, changed on disk before apply: conf.txt',
        'Nothing else is pending.',
      ].join('\n'),
    );
  });

  it('mentions proposals that are still pending', async () => {
    const s = await setup();
    await s.tools().stage('a.txt', 'x\n');
    const p = await s.pending();
    await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    await s.tools().stage('b.txt', 'y\n');
    const note = await s.svc.takeNote(CHAT, { mode: 'review', firstTurn: false });
    expect(note).toContain('- Written: a.txt (1 of 1)');
    expect(note?.endsWith('1 proposed file is still awaiting review. Your reads show your proposed versions.')).toBe(
      true,
    );
  });

  it('removes the change set file with the chat', async () => {
    const s = await setup();
    await s.tools().stage('a.txt', 'x\n');
    const file = path.join(s.dataDir, 'changes', `${CHAT}.json`);
    expect((await fs.stat(file)).isFile()).toBe(true);
    await s.svc.removeForChat(CHAT);
    await expect(fs.stat(file)).rejects.toThrow();
    expect(await s.svc.get(CHAT)).toEqual({ pending: null, applied: [], diskSeq: 0 });
    await s.svc.removeForChat(CHAT); // idempotent
  });

  it('rejects chat ids that are not safe file names', async () => {
    const s = await setup();
    await expect(s.svc.get('../x')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('hunk headers', () => {
  it('uses the nearest declaration above the hunk', async () => {
    const s = await setup();
    const body = [
      'export function alpha() {',
      ...lines(10, '  x'),
      '}',
      '',
      'export const beta = {',
      ...lines(10, '  y'),
      '};',
    ];
    await s.write('h.ts', `${body.join('\n')}\n`);
    const next = [...body];
    next[17] = '  y CHANGED';
    await s.tools().stage('h.ts', `${next.join('\n')}\n`);
    expect((await s.pending())?.files[0]?.hunks[0]?.header).toBe('export const beta = {');
  });
});

describe('design sample (ReviewChanges)', () => {
  /** Base and new text for a mock FileChange: filler lines place each hunk at its old line number. */
  function texts(change: FileChange): { base: string | null; next: string } {
    const baseLines: string[] = [];
    const newLines: string[] = [];
    for (const h of change.hunks) {
      while (baseLines.length < h.oldStart - 1) {
        const filler = `// filler ${baseLines.length + 1}`;
        baseLines.push(filler);
        newLines.push(filler);
      }
      for (const l of h.lines) {
        if (l[0] !== '+') baseLines.push(l.slice(1));
        if (l[0] !== '-') newLines.push(l.slice(1));
      }
    }
    return {
      base: change.kind === 'create' ? null : `${baseLines.join('\n')}\n`,
      next: `${newLines.join('\n')}\n`,
    };
  }

  async function stageSample() {
    const s = await setup();
    const sample = sampleProposal();
    const expected: Record<string, { base: string | null; next: string }> = {};
    for (const change of sample) {
      expected[change.path] = texts(change);
      const { base, next } = expected[change.path] as { base: string | null; next: string };
      if (base !== null) await s.write(change.path, base);
      await s.tools().stage(change.path, next);
    }
    return { s, expected };
  }

  it('proposes 3 files and 4 hunks like the design', async () => {
    const { s } = await stageSample();
    const p = await s.pending();
    expect(p?.files.map((f) => [f.path, f.kind, f.hunks.length])).toEqual([
      ['src/core/tools/index.ts', 'modify', 2],
      ['src/core/tools/write-file.ts', 'create', 1],
      ['src/shared/constants.ts', 'modify', 1],
    ]);
    expect(p?.files[2]?.hunks[0]?.id).toMatch(/^41:[0-9a-f]{8}$/);
  });

  it('with only c1 (the constants hunk) accepted and the rest rejected, writes exactly that file', async () => {
    const { s, expected } = await stageSample();
    const p = await s.pending();
    const decisions: Record<string, Record<string, HunkDecision>> = {};
    for (const f of p?.files ?? []) {
      decisions[f.path] = Object.fromEntries(
        f.hunks.map((h) => [h.id, f.path === 'src/shared/constants.ts' ? 'accepted' : 'rejected']),
      );
    }
    const res = await s.apply(p?.revision ?? 0, decisions);
    expect(res.batch.rejectedHunks).toBe(3);
    expect(res.batch.written.map((f) => f.path)).toEqual(['src/shared/constants.ts']);
    expect(await s.read('src/shared/constants.ts')).toBe(expected['src/shared/constants.ts']?.next);
    expect(await s.read('src/core/tools/index.ts')).toBe(expected['src/core/tools/index.ts']?.base);
    expect(await s.exists('src/core/tools/write-file.ts')).toBe(false);
  });

  it('accepting everything reproduces every proposed file byte for byte', async () => {
    const { s, expected } = await stageSample();
    const p = await s.pending();
    await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    for (const [file, { next }] of Object.entries(expected)) expect(await s.read(file)).toBe(next);
  });
});

// ------------------------------------------------------------------------------------------------ A1 additions

const REVIEW = { mode: 'review', firstTurn: false } as const;

describe('review: too-large proposals (A1)', () => {
  /** `n` lines, all different from `lines(n, 'old')`. */
  const bigPair = (n: number) => ({ old: `${lines(n, 'old').join('\n')}\n`, next: `${lines(n, 'new').join('\n')}\n` });

  it('stage refuses a diff over the review limit with tooLargeToReviewText and stores nothing', async () => {
    const s = await setup();
    const n = LIMITS.diffMaxLinesPerFile / 2 + 1; // n removed + n added lines, no context
    const { old, next } = bigPair(n);
    await s.write('big.txt', old);
    await expect(s.tools().stage('big.txt', next)).rejects.toMatchObject({
      code: 'invalid_request',
      message: tooLargeToReviewText('big.txt'),
    });
    expect(await s.pending()).toBeNull();
    expect(await s.read('big.txt')).toBe(old);
    expect(await s.tools().staged()).toEqual([]);
  });

  it('a diff exactly at the limit is still proposed', async () => {
    const s = await setup();
    const { old, next } = bigPair(LIMITS.diffMaxLinesPerFile / 2);
    await s.write('big.txt', old);
    const r = await s.tools().stage('big.txt', next);
    expect(r.file?.tooLarge).toBeUndefined();
    expect(r.file?.hunks.length).toBeGreaterThan(0);
  });

  it('refuses a new file with too many lines, too', async () => {
    const s = await setup();
    const text = `${lines(LIMITS.diffMaxLinesPerFile + 1, 'x').join('\n')}\n`;
    await expect(s.tools().stage('new.txt', text)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await s.pending()).toBeNull();
  });

  it('a refused second stage leaves the earlier proposal of that file and the revision untouched', async () => {
    const s = await setup();
    const { old, next } = bigPair(LIMITS.diffMaxLinesPerFile / 2 + 1);
    await s.write('big.txt', old);
    await s.write('other.txt', 'o\n');
    await s.tools().stage('other.txt', 'o2\n');
    const r1 = await s
      .tools()
      .stage('big.txt', `${old.split('\n')[0]} CHANGED\n${old.split('\n').slice(1).join('\n')}`);
    const before = await s.pending();
    await expect(s.tools().stage('big.txt', next)).rejects.toMatchObject({ message: tooLargeToReviewText('big.txt') });
    expect(await s.pending()).toEqual(before);
    expect(r1.file?.kind).toBe('modify');
    expect((await s.tools().read('big.txt'))?.kind).toBe('staged');
    const res = await s.apply(before?.revision ?? 0, await s.allOf('accepted'));
    expect(res.batch.written.map((f) => f.path)).toEqual(['big.txt', 'other.txt']);
  });
});

describe('review: legacy too-large pending files (A1)', () => {
  /** A v0.3 store holding a pending file whose diff is too large to review (older builds could stage one). */
  async function legacy(extra: { ok?: boolean } = {}) {
    const s = await setup();
    const n = LIMITS.diffMaxLinesPerFile / 2 + 1;
    const old = `${lines(n, 'old').join('\n')}\n`;
    await s.write('big.txt', old);
    const files = [
      {
        path: 'big.txt',
        baseHash: sha256(old),
        baseContent: old,
        content: `${lines(n, 'new').join('\n')}\n`,
        lastMessageId: 'm',
      },
    ];
    if (extra.ok) {
      await s.write('ok.txt', 'a\n');
      files.push({ path: 'ok.txt', baseHash: sha256('a\n'), baseContent: 'a\n', content: 'b\n', lastMessageId: 'm' });
    }
    await fs.mkdir(path.join(s.dataDir, 'changes'), { recursive: true });
    await fs.writeFile(
      path.join(s.dataDir, 'changes', `${CHAT}.json`),
      JSON.stringify({ version: 1, revision: 4, messageId: 'm', files, snapshots: [], applied: [], events: [] }),
    );
    return { s, old };
  }

  it('apply reports too_large, writes nothing, and the note has the line', async () => {
    const { s, old } = await legacy();
    const p = await s.pending();
    expect(p?.files[0]).toMatchObject({ path: 'big.txt', tooLarge: true, hunks: [] });
    const res = await s.apply(p?.revision ?? 0, { 'big.txt': {} });
    expect(res.batch.conflicts).toEqual([{ path: 'big.txt', reason: 'too_large' }]);
    expect(res.batch.written).toEqual([]);
    expect(res.batch.source).toBe('review');
    expect(res.changes.applied).toHaveLength(1);
    expect(res.changes.pending).toBeNull();
    expect(res.changes.diskSeq).toBe(0); // nothing was written
    expect(await s.read('big.txt')).toBe(old);
    // The stored event keeps too_large out of `conflicts` (an older build's enum would fail on it).
    const stored = JSON.parse(await fs.readFile(path.join(s.dataDir, 'changes', `${CHAT}.json`), 'utf8'));
    expect(stored.events[0]).toMatchObject({ type: 'applied', conflicts: [], tooLarge: ['big.txt'] });
    expect(await s.svc.takeNote(CHAT, REVIEW)).toBe(
      [
        '[OpenVern] Since your last reply the user reviewed your proposed edits:',
        '- Not written, too large to review: big.txt',
        'Nothing else is pending.',
      ].join('\n'),
    );
  });

  it('accepting everything still writes the other files; the too-large line follows the conflict lines', async () => {
    const { s } = await legacy({ ok: true });
    await s.write('conf.txt', 'a\n');
    await s.tools().stage('conf.txt', 'b\n');
    await s.write('conf.txt', 'changed meanwhile\n');
    const p = await s.pending();
    const res = await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    expect(res.batch.written.map((f) => f.path)).toEqual(['ok.txt']);
    expect(res.batch.conflicts).toEqual([
      { path: 'big.txt', reason: 'too_large' },
      { path: 'conf.txt', reason: 'changed_on_disk' },
    ]);
    expect(await s.read('ok.txt')).toBe('b\n');
    expect(res.changes.diskSeq).toBe(1);
    expect(await s.svc.takeNote(CHAT, REVIEW)).toBe(
      [
        '[OpenVern] Since your last reply the user reviewed your proposed edits:',
        '- Written: ok.txt (1 of 1)',
        '- Not written, changed on disk before apply: conf.txt',
        '- Not written, too large to review: big.txt',
        'Nothing else is pending.',
      ].join('\n'),
    );
  });
});

describe('diskSeq (A1)', () => {
  it('apply bumps it only when it wrote something', async () => {
    const s = await setup();
    expect((await s.svc.get(CHAT)).diskSeq).toBe(0);
    await s.write('a.txt', 'a\n');
    await s.write('c.txt', 'c\n');
    await s.tools().stage('a.txt', 'b\n');
    let p = await s.pending();
    // All rejected: nothing written.
    let res = await s.apply(p?.revision ?? 0, await s.allOf('rejected'));
    expect(res.changes.diskSeq).toBe(0);
    // Written.
    await s.tools().stage('a.txt', 'b\n');
    p = await s.pending();
    res = await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    expect(res.changes.diskSeq).toBe(1);
    // Only a conflict: nothing written.
    await s.tools().stage('c.txt', 'd\n');
    await s.write('c.txt', 'outside\n');
    p = await s.pending();
    res = await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    expect(res.batch.conflicts).toHaveLength(1);
    expect(res.changes.diskSeq).toBe(1);
    // Undecided: nothing written.
    await s.tools().stage('a.txt', 'e\n');
    p = await s.pending();
    res = await s.apply(p?.revision ?? 0, {});
    expect(res.changes.diskSeq).toBe(1);
    // A file delete is a write too.
    await s.tools().stage('a.txt', null);
    p = await s.pending();
    res = await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    expect(res.changes.diskSeq).toBe(2);
    expect((await s.svc.get(CHAT)).diskSeq).toBe(2);
    // discard / snapshot / restore never move it.
    await s.tools().stage('x.txt', 'x\n');
    await s.svc.discard(CHAT);
    expect((await s.svc.get(CHAT)).diskSeq).toBe(2);
  });

  it('staging alone does not bump it, and a refused stale apply does not either', async () => {
    const s = await setup();
    await s.tools().stage('a.txt', 'x\n');
    const p = await s.pending();
    await s.tools().stage('b.txt', 'y\n');
    await expect(s.apply(p?.revision ?? 0, await s.allOf('accepted'))).rejects.toMatchObject({ code: 'changes_stale' });
    expect((await s.svc.get(CHAT)).diskSeq).toBe(0);
  });
});

describe('v0.3 stores (A1)', () => {
  it('a store without any Auto field loads as Review history with diskSeq 0', async () => {
    const s = await setup();
    const batch = {
      id: 'b1',
      appliedAt: '2026-01-01T00:00:00.000Z',
      messageId: 'm1',
      written: [{ path: 'a.txt', kind: 'create', add: 1, del: 0, hunks: [] }],
      rejectedHunks: 0,
      skippedHunks: 0,
      conflicts: [{ path: 'x.txt', reason: 'changed_on_disk' }],
    };
    await fs.mkdir(path.join(s.dataDir, 'changes'), { recursive: true });
    await fs.writeFile(
      path.join(s.dataDir, 'changes', `${CHAT}.json`),
      JSON.stringify({
        version: 1,
        revision: 2,
        messageId: 'm1',
        files: [],
        snapshots: [],
        applied: [batch],
        events: [],
      }),
    );
    const got = await s.svc.get(CHAT);
    expect(got.diskSeq).toBe(0);
    expect(got.applied).toEqual([{ ...batch, source: 'review', undoable: false }]);
    expect(got.applied[0]).not.toHaveProperty('turnId');
    // Not quarantined, and still usable.
    expect((await fs.readdir(path.join(s.dataDir, 'changes'))).some((n) => n.includes('.corrupt-'))).toBe(false);
    await s.tools().stage('n.txt', 'x\n');
    expect((await s.pending())?.files).toHaveLength(1);
  });

  it('a malformed lastMode loads as missing (Review) and does not quarantine the store', async () => {
    const s = await setup();
    await fs.mkdir(path.join(s.dataDir, 'changes'), { recursive: true });
    const file = path.join(s.dataDir, 'changes', `${CHAT}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        revision: 0,
        messageId: '',
        files: [],
        snapshots: [],
        applied: [],
        events: [],
        lastMode: 'bogus',
      }),
    );
    expect(await s.svc.get(CHAT)).toEqual({ pending: null, applied: [], diskSeq: 0 });
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false })).toBe(modeChangedNote('auto'));
    expect((await fs.readdir(path.join(s.dataDir, 'changes'))).some((n) => n.includes('.corrupt-'))).toBe(false);
  });
});

describe('takeNote (A1)', () => {
  const storeWith = async (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown>) => {
    await fs.mkdir(path.join(s.dataDir, 'changes'), { recursive: true });
    await fs.writeFile(
      path.join(s.dataDir, 'changes', `${CHAT}.json`),
      JSON.stringify({
        version: 1,
        revision: 0,
        messageId: '',
        files: [],
        snapshots: [],
        applied: [],
        events: [],
        ...extra,
      }),
    );
  };

  it('is undefined when there is nothing to report, and the mode is recorded either way', async () => {
    const s = await setup();
    expect(await s.svc.takeNote(CHAT, { mode: 'review', firstTurn: false })).toBeUndefined();
    expect(await s.svc.takeNote(CHAT, { mode: 'review', firstTurn: true })).toBeUndefined();
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: true })).toBeUndefined();
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false })).toBeUndefined();
  });

  it('adds the mode line when the mode differs from the last noted mode; a store without one counts as Review', async () => {
    const s = await setup();
    // Missing lastMode = Review: Auto differs.
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false })).toBe(
      '[OpenVern] Edit mode changed since your last reply: Auto. Your edits are now written to disk as soon as each edit tool call succeeds, and the user can undo a whole turn.',
    );
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false })).toBeUndefined();
    expect(await s.svc.takeNote(CHAT, { mode: 'review', firstTurn: false })).toBe(
      '[OpenVern] Edit mode changed since your last reply: Review. Your edits are proposals again: nothing is written until the user applies them.',
    );
    expect(await s.svc.takeNote(CHAT, { mode: 'review', firstTurn: false })).toBeUndefined();
  });

  it('adds no mode line on the first turn, but records the mode for the next one', async () => {
    const s = await setup();
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: true })).toBeUndefined();
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false })).toBeUndefined();
    expect(await s.svc.takeNote(CHAT, { mode: 'review', firstTurn: false })).toBe(modeChangedNote('review'));
  });

  it('the first turn still reports review events, without a mode line', async () => {
    const s = await setup();
    await s.tools().stage('a.txt', 'x\n');
    await s.svc.discard(CHAT);
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: true })).toBe(
      '[OpenVern] Since your last reply the user reviewed your proposed edits:\n- Discarded: a.txt (new file, not created)\nNothing else is pending.',
    );
  });

  it('keeps the review block byte-identical when a mode line precedes it', async () => {
    const s = await setup();
    await s.tools().stage('a.txt', 'x\n');
    await s.svc.discard(CHAT);
    // The same text the existing "discards and notes it" test pins, after a blank line and the mode line.
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false })).toBe(
      `${modeChangedNote('auto')}\n\n[OpenVern] Since your last reply the user reviewed your proposed edits:\n- Discarded: a.txt (new file, not created)\nNothing else is pending.`,
    );
  });

  it('the undo block lists restored files and every skip reason, de-duplicated across undos', async () => {
    const s = await setup();
    await storeWith(s, {
      lastMode: 'auto',
      undone: [
        { restored: ['a.ts', 'b.ts'], skipped: [{ path: 'c.ts', reason: 'changed_since' }] },
        {
          restored: ['b.ts'],
          skipped: [
            { path: 'd.ts', reason: 'blocked' },
            { path: 'e.ts', reason: 'unavailable' },
            { path: 'c.ts', reason: 'changed_since' },
          ],
        },
      ],
    });
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false })).toBe(
      [
        '[OpenVern] Since your last reply the user undid your edits from an earlier turn:',
        '- Restored to their earlier content: a.ts, b.ts',
        '- Not undone, changed since: c.ts',
        '- Not undone, blocked: d.ts',
        '- Not undone, original not available: e.ts',
      ].join('\n'),
    );
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false })).toBeUndefined(); // cleared
  });

  it('the combined note is: mode line, review block, undo block, separated by a blank line', async () => {
    const s = await setup();
    await storeWith(s, { lastMode: 'review' });
    await s.write('f.txt', 'one\n');
    // A discarded proposal (review block).
    await s.tools().stage('p.txt', 'p\n');
    await s.svc.discard(CHAT);
    // A user undo of an Auto turn (undo block).
    const auto = s.svc.tools({
      chatId: CHAT,
      projectId: 'p',
      projectRoot: s.root,
      messageId: 'm',
      turnId: 'tA',
      mode: 'auto',
    });
    const bytes = await fs.readFile(path.join(s.root, 'f.txt'));
    auto.noteRead('f.txt', bytes);
    await auto.write('f.txt', 'two\n', { tool: 'write_file', baseHash: sha256(bytes) });
    const batch = (await s.svc.get(CHAT)).applied[0];
    await s.svc.undoBatch({ chatId: CHAT, projectId: 'p', projectRoot: s.root, batchId: batch?.id as string });
    expect(await s.read('f.txt')).toBe('one\n');
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false })).toBe(
      [
        modeChangedNote('auto'),
        '',
        '[OpenVern] Since your last reply the user reviewed your proposed edits:\n- Discarded: p.txt (new file, not created)\nNothing else is pending.',
        '',
        '[OpenVern] Since your last reply the user undid your edits from an earlier turn:\n- Restored to their earlier content: f.txt',
      ].join('\n'),
    );
    expect(await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false })).toBeUndefined();
  });

  it('review block with still-pending files keeps its closing line after a mode line', async () => {
    const s = await setup();
    await s.tools().stage('a.txt', 'x\n');
    const p = await s.pending();
    await s.apply(p?.revision ?? 0, await s.allOf('accepted'));
    await s.tools().stage('b.txt', 'y\n');
    const note = await s.svc.takeNote(CHAT, { mode: 'auto', firstTurn: false });
    expect(note?.startsWith(`${modeChangedNote('auto')}\n\n[OpenVern] Since your last reply the user reviewed`)).toBe(
      true,
    );
    expect(note?.endsWith('1 proposed file is still awaiting review. Your reads show your proposed versions.')).toBe(
      true,
    );
  });
});

describe('removeForChat and the blob folder (A1)', () => {
  it('deletes the store and the blob folder, forgets the read record, and is idempotent', async () => {
    const s = await setup();
    await s.write('a.txt', 'orig\n');
    const auto = () =>
      s.svc.tools({ chatId: CHAT, projectId: 'p', projectRoot: s.root, messageId: 'm', turnId: 't', mode: 'auto' });
    const tc = auto();
    const bytes = await fs.readFile(path.join(s.root, 'a.txt'));
    tc.noteRead('a.txt', bytes);
    await tc.write('a.txt', 'new\n', { tool: 'write_file', baseHash: sha256(bytes) });
    const blobDir = path.join(s.dataDir, 'changes', `${CHAT}.blobs`);
    expect(await fs.readdir(blobDir)).toEqual([sha256('orig\n')]);
    // Another chat's folder is not touched.
    const other = path.join(s.dataDir, 'changes', 'other.blobs');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'x'), 'x');

    await s.svc.removeForChat(CHAT);
    await expect(fs.stat(blobDir)).rejects.toThrow();
    await expect(fs.stat(path.join(s.dataDir, 'changes', `${CHAT}.json`))).rejects.toThrow();
    expect(await fs.readdir(other)).toEqual(['x']);
    expect(await s.svc.get(CHAT)).toEqual({ pending: null, applied: [], diskSeq: 0 });
    await s.svc.removeForChat(CHAT); // idempotent
    // The record went with the chat: the (now unrecorded) file needs a read again.
    const bytes2 = await fs.readFile(path.join(s.root, 'a.txt'));
    await expect(auto().write('a.txt', 'x\n', { tool: 'write_file', baseHash: sha256(bytes2) })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(s.svc.removeForChat('../x')).rejects.toMatchObject({ code: 'not_found' });
  });
});
