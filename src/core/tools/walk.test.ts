import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderTree } from './tree';
import { type WalkEntry, walk } from './walk';

const isWindows = process.platform === 'win32';

let base: string;
let root: string;
let evil: string;
const fifos: string[] = [];

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-walk-')));
  root = path.join(base, 'proj');
  await mkdir(root);
  await mkdir(path.join(base, 'outside'));
  evil = path.join(base, 'outside', 'evil.gitignore');
  await writeFile(evil, '*.txt\n');
});

afterAll(async () => {
  // A reader blocked in open() on a FIFO holds a libuv thread; open the write end to release it.
  for (const fifo of fifos) {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {}
  }
  await rm(base, { recursive: true, force: true });
});

async function put(rel: string, content = 'x\n'): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function link(rel: string, target: string): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await symlink(target, abs);
}

async function makeFifo(rel: string): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  execFileSync('mkfifo', [abs]);
  fifos.push(abs);
}

async function entries(startRel: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  for await (const e of walk({ root, startRel, maxDepth: Infinity, signal: new AbortController().signal })) out.push(e);
  return out;
}

async function names(startRel: string): Promise<string[]> {
  return (await entries(startRel)).map((e) => e.rel);
}

describe('walk .gitignore hardening', () => {
  it('ignores a symlinked .gitignore that points outside the root', { timeout: 2000 }, async () => {
    await link('sym/.gitignore', evil);
    await put('sym/a.txt');
    const list = await entries('sym');
    expect(list.map((e) => e.rel)).toContain('sym/a.txt');
    expect(list.find((e) => e.rel === 'sym/.gitignore')?.kind).toBe('symlink');
  });

  it.skipIf(isWindows)('does not hang on a FIFO .gitignore', { timeout: 2000 }, async () => {
    await makeFifo('fifo/.gitignore');
    await put('fifo/a.txt');
    const list = await names('fifo');
    expect(list).toContain('fifo/a.txt');
    expect(list).not.toContain('fifo/.gitignore');
  });

  it.skipIf(isWindows)('does not read a .gitignore symlinked to a device', { timeout: 2000 }, async () => {
    await link('dev/.gitignore', '/dev/zero');
    await put('dev/a.txt');
    // Node gives up on /dev/zero by itself (string length limit), so the tell is the memory spike from reading it.
    const peakBefore = process.resourceUsage().maxRSS; // KiB
    expect(await names('dev')).toContain('dev/a.txt');
    expect(process.resourceUsage().maxRSS - peakBefore).toBeLessThan(64 * 1024);
  });

  it('ignores a symlinked ancestor .gitignore when walking a subdirectory', { timeout: 2000 }, async () => {
    await link('anc/.gitignore', evil);
    await put('anc/sub/a.txt');
    expect(await names('anc/sub')).toContain('anc/sub/a.txt');
  });

  it('skips a .gitignore larger than LIMITS.gitignoreMaxBytes', { timeout: 2000 }, async () => {
    await put('big/.gitignore', `*.txt\n${'#'.repeat(LIMITS.gitignoreMaxBytes)}`);
    await put('big/a.txt');
    await put('big/sub/b.txt');
    expect(await names('big')).toContain('big/a.txt');
    expect(await names('big/sub')).toContain('big/sub/b.txt');
  });

  it('still honours a regular .gitignore, per-dir and ancestor', { timeout: 2000 }, async () => {
    await put('ok/.gitignore', '*.txt\n');
    await put('ok/a.txt');
    await put('ok/keep.md');
    await put('ok/sub/b.txt');
    await put('ok/sub/keep.md');
    const fromOk = await names('ok');
    expect(fromOk).toContain('ok/keep.md');
    expect(fromOk).toContain('ok/sub/keep.md');
    expect(fromOk).not.toContain('ok/a.txt');
    expect(fromOk).not.toContain('ok/sub/b.txt');
    const fromSub = await names('ok/sub');
    expect(fromSub).toContain('ok/sub/keep.md');
    expect(fromSub).not.toContain('ok/sub/b.txt');
  });

  it.skipIf(isWindows)('renderTree returns for a project with a FIFO .gitignore', { timeout: 2000 }, async () => {
    const proj = path.join(base, 'tree-proj');
    await mkdir(proj);
    execFileSync('mkfifo', [path.join(proj, '.gitignore')]);
    fifos.push(path.join(proj, '.gitignore'));
    await writeFile(path.join(proj, 'a.txt'), 'x\n');
    const tree = await renderTree(proj, { depth: 2, maxEntries: 50 });
    expect(tree.split('\n')).toContain('a.txt');
  });
});
