import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import type { DiffHunk, FileChange, HunkDecision } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { sampleProposal } from '../../renderer/lib/mock-changes';
import { ensureDataDir } from '../storage/paths';
import { cleanupTempDirs, makeTempDir } from '../storage/test-helpers';
import { acceptAll, createChangesService } from './index';

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
  const tools = (messageId = MSG) => svc.tools({ chatId: CHAT, projectRoot: realRoot, messageId });
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

  it('acceptAll builds a decision map for every hunk', async () => {
    const s = await setup();
    await s.write('f.txt', 'a\n');
    await s.tools().stage('f.txt', 'b\n');
    const p = await s.pending();
    const decisions = acceptAll(p as NonNullable<typeof p>);
    expect(Object.keys(decisions)).toEqual(['f.txt']);
    await s.apply(p?.revision ?? 0, decisions);
    expect(await s.read('f.txt')).toBe('b\n');
  });
});

describe('discard, snapshot/restore, notes, cleanup', () => {
  it('discards and notes it', async () => {
    const s = await setup();
    await s.tools().stage('a.txt', 'x\n');
    const r = await s.svc.discard(CHAT);
    expect(r.pending).toBeNull();
    expect(await s.exists('a.txt')).toBe(false);
    expect(await s.svc.takeNote(CHAT)).toBe(
      '[OpenVern] Since your last reply the user reviewed your proposed edits:\n- Discarded: a.txt (new file, not created)\nNothing else is pending.',
    );
    expect(await s.svc.takeNote(CHAT)).toBeUndefined();
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
    expect(await s.svc.takeNote(CHAT)).toBe(
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
    const note = await s.svc.takeNote(CHAT);
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
    expect(await s.svc.get(CHAT)).toEqual({ pending: null, applied: [] });
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
