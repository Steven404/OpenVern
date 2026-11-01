// S1-M1: the app's data dir is unreachable from the project tools even when the project folder contains it.
// Deliberately no `.gitignore` in the fixture: the deny must not depend on ignore rules.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProjectTools, renderTree } from './index';
import { BLOCKED_MESSAGE } from './sandbox';
import type { Tool, ToolContext } from './types';

const SECRET = 'sk-or-SECRET';

let base: string;
let proj: string;
let data: string;
let ctx: ToolContext;
let tools: Tool[];

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'harness-b2-')));
  proj = path.join(base, 'proj');
  data = path.join(proj, '.dev-data');
  await mkdir(path.join(data, 'chats'), { recursive: true });
  await writeFile(path.join(proj, 'README.md'), '# readme\n');
  await writeFile(path.join(data, 'secrets.json'), JSON.stringify({ openrouter: SECRET }));
  await writeFile(path.join(data, 'chats', 'x.json'), '{"note":"SECRET chat"}');
  await symlink(data, path.join(proj, 'innocent'));
  ctx = { projectRoot: proj, signal: new AbortController().signal };
  tools = getProjectTools({ deniedRoots: [data] });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function run(name: string, args: unknown) {
  const t = tools.find((x) => x.spec.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.run(args, ctx);
}

describe('data dir inside a project (S1-M1)', () => {
  it('read_file cannot read the key, directly or through a symlink', async () => {
    for (const p of ['.dev-data/secrets.json', 'innocent/secrets.json']) {
      const res = await run('read_file', { path: p });
      expect(res.ok, p).toBe(false);
      expect(res.output).toContain(BLOCKED_MESSAGE);
      expect(res.output).not.toContain(SECRET);
    }
  });

  it('list_files never shows or enters the data dir', async () => {
    const all = await run('list_files', { path: '.', depth: 5 });
    expect(all.ok).toBe(true);
    expect(all.output).toContain('README.md');
    expect(all.output).not.toContain('.dev-data');
    expect(all.output).not.toContain('secrets.json');
    const inside = await run('list_files', { path: '.dev-data' });
    expect(inside.ok).toBe(false);
    expect(inside.output).toContain(BLOCKED_MESSAGE);
  });

  it('search never matches inside the data dir', async () => {
    const res = await run('search', { query: SECRET });
    expect(res.output).toMatch(/^No matches/);
    expect(res.output).not.toContain('.dev-data');
    expect(res.output).not.toContain('secrets.json');
    const viaLink = await run('search', { query: 'SECRET', path: 'innocent' });
    expect(viaLink.ok).toBe(false);
    expect(viaLink.output).toContain(BLOCKED_MESSAGE);
  });

  it('renderTree hides the data dir and renders a project inside it as empty', async () => {
    const tree = await renderTree(proj, { depth: 3, maxEntries: 100, deniedRoots: [data] });
    expect(tree).toContain('README.md');
    expect(tree).not.toContain('.dev-data');
    expect(tree).not.toContain('secrets.json');
    expect(await renderTree(path.join(data, 'chats'), { depth: 3, maxEntries: 100, deniedRoots: [data] })).toBe(
      '(empty)',
    );
  });
});
