// S1-M1: the app's data dir is unreachable from the project tools even when the project folder contains it.
// Deliberately no `.gitignore` in the fixture: the deny must not depend on ignore rules.

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultDataDirRoots } from '../index';
import { getProjectTools, renderTree } from './index';
import { BLOCKED_MESSAGE } from './sandbox';
import { createFakeChangesService } from './test-changes';
import type { Tool, ToolContext } from './types';

const SECRET = 'sk-or-SECRET';

let base: string;
let proj: string;
let data: string;
let ctx: ToolContext;
let tools: Tool[];

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-b2-')));
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

// S1-M1 follow-up: other OpenVern data dirs (dev, prod, custom) are denied by name, file name and layout marker.
describe('other OpenVern data dirs', () => {
  let b2: string;
  let p2: string;
  let t2: Tool[];
  let c2: ToolContext;
  const KEY = 'sk-or-OTHERSECRET';
  const run2 = (name: string, args: unknown) => {
    const t = t2.find((x) => x.spec.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(args, c2);
  };

  beforeAll(async () => {
    b2 = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-b2b-')));
    p2 = path.join(b2, 'proj');
    await mkdir(path.join(p2, '.dev-data', 'chats'), { recursive: true });
    await mkdir(path.join(p2, '.DEV-DATA-two'), { recursive: true });
    await writeFile(path.join(p2, '.dev-data', 'secrets.json'), KEY);
    await writeFile(path.join(p2, '.DEV-DATA-two', 'note.txt'), KEY);
    // custom data dir: marker layout, innocuous name
    const custom = path.join(p2, 'custom-data');
    await mkdir(path.join(custom, 'chats'), { recursive: true });
    await writeFile(path.join(custom, 'secrets.json'), KEY);
    await writeFile(path.join(custom, 'projects.json'), KEY);
    await writeFile(path.join(custom, 'chats', 'index.json'), '[]');
    await writeFile(path.join(custom, 'chats', 'c1.json'), KEY);
    // nested inside an ordinary dir, and a chats-only data dir (no key yet)
    const nested = path.join(p2, 'a', 'b', 'nodekey');
    await mkdir(path.join(nested, 'chats'), { recursive: true });
    await writeFile(path.join(nested, 'projects.json'), '[]');
    await writeFile(path.join(nested, 'chats', 'index.json'), '[]');
    await writeFile(path.join(nested, 'chats', 'c.json'), KEY);
    // secrets.json at depth, outside any data dir
    await mkdir(path.join(p2, 'deep', 'er'), { recursive: true });
    await writeFile(path.join(p2, 'deep', 'er', 'Secrets.JSON'), KEY);
    // ordinary repo with a chats/ folder (must stay visible)
    await mkdir(path.join(p2, 'app', 'chats'), { recursive: true });
    await writeFile(path.join(p2, 'app', 'chats', 'index.json'), 'OKCHAT');
    await writeFile(path.join(p2, 'app', 'chats', 'view.ts'), 'OKVIEW');
    await writeFile(path.join(p2, 'README.md'), '# r\n');
    await symlink(custom, path.join(p2, 'link-custom'));
    await symlink(path.join(p2, '.dev-data'), path.join(p2, 'link-dev'));
    c2 = { projectRoot: p2, signal: new AbortController().signal };
    t2 = getProjectTools();
  });
  afterAll(async () => {
    await rm(b2, { recursive: true, force: true });
  });

  it('read_file is blocked for .dev-data*, secrets.json anywhere, marker dirs and symlinks to them', async () => {
    for (const p of [
      '.dev-data/secrets.json',
      '.DEV-DATA-two/note.txt',
      'deep/er/Secrets.JSON',
      'custom-data/chats/c1.json',
      'custom-data/secrets.json',
      'a/b/nodekey/chats/c.json',
      'link-custom/chats/c1.json',
      'link-custom/secrets.json',
      'link-dev/secrets.json',
    ]) {
      const res = await run2('read_file', { path: p });
      expect(res.ok, p).toBe(false);
      expect(res.output, p).toContain(BLOCKED_MESSAGE);
      expect(res.output, p).not.toContain(KEY);
    }
  });

  it('list_files and renderTree never expose them but keep an ordinary chats/ folder', async () => {
    const all = await run2('list_files', { path: '.', depth: 5 });
    const tree = await renderTree(p2, { depth: 6, maxEntries: 200 });
    for (const out of [all.output, tree]) {
      expect(out).toContain('README.md');
      expect(out).toContain('view.ts');
      for (const hidden of ['.dev-data', 'DEV-DATA', 'custom-data', 'nodekey', 'secrets', 'Secrets', 'c1.json']) {
        expect(out, hidden).not.toContain(hidden);
      }
    }
    for (const p of ['custom-data', 'link-custom', 'a/b/nodekey', 'a/b/nodekey/chats']) {
      const r = await run2('list_files', { path: p });
      expect(r.ok, p).toBe(false);
      expect(r.output).toContain(BLOCKED_MESSAGE);
    }
    expect(await renderTree(path.join(p2, 'custom-data'), { depth: 3, maxEntries: 50 })).toBe('(empty)');
  });

  it('search never matches inside them but still searches an ordinary chats/ folder', async () => {
    const res = await run2('search', { query: 'OTHERSECRET' });
    expect(res.output).toMatch(/^No matches/);
    const ok = await run2('search', { query: 'OKVIEW' });
    expect(ok.output).toContain('app/chats/view.ts');
    const direct = await run2('search', { query: 'OTHERSECRET', path: 'custom-data' });
    expect(direct.ok).toBe(false);
    expect(direct.output).toContain(BLOCKED_MESSAGE);
  });

  it('does not block an ordinary chats/index.json without a data-dir sibling file', async () => {
    const res = await run2('read_file', { path: 'app/chats/index.json' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('OKCHAT');
  });
});

describe('default production data dir', () => {
  it('honours XDG_CONFIG_HOME, else ~/.config/openvern (and the legacy harness dir); realpaths when present, lexical when absent', async () => {
    const base2 = await realpath(await mkdtemp(path.join(tmpdir(), 'openvern-xdg-')));
    try {
      const xdg = path.join(base2, 'xdg');
      expect(await defaultDataDirRoots({ XDG_CONFIG_HOME: xdg }, base2, 'linux')).toEqual([
        path.join(xdg, 'openvern'),
        path.join(xdg, 'harness'),
      ]);
      expect(await defaultDataDirRoots({}, base2, 'linux')).toEqual([
        path.join(base2, '.config', 'openvern'),
        path.join(base2, '.config', 'harness'),
      ]);
      await mkdir(path.join(base2, 'real', 'openvern'), { recursive: true });
      await symlink(path.join(base2, 'real'), xdg);
      const [d] = await defaultDataDirRoots({ XDG_CONFIG_HOME: xdg }, base2, 'linux');
      expect(d).toBe(path.join(base2, 'real', 'openvern'));
      // through the tools: a "~" project cannot reach it, even via the symlink
      await writeFile(path.join(d as string, 'x.txt'), 'PRODSECRET');
      const tools2 = getProjectTools({ deniedRoots: [d as string] });
      const read = tools2.find((t) => t.spec.name === 'read_file');
      const ctx2 = { projectRoot: base2, signal: new AbortController().signal };
      for (const p of ['xdg/openvern/x.txt', 'real/openvern/x.txt']) {
        const r = await read?.run({ path: p }, ctx2);
        expect(r?.ok, p).toBe(false);
        expect(r?.output).toContain(BLOCKED_MESSAGE);
      }
    } finally {
      await rm(base2, { recursive: true, force: true });
    }
  });
});

describe('platform default roots', () => {
  it('preserves the non-darwin pair, including canonical duplicates', async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'roots-')));
    try {
      const config = path.join(home, '.config');
      await mkdir(path.join(config, 'openvern'), { recursive: true });
      await symlink(path.join(config, 'openvern'), path.join(config, 'harness'));
      for (const platform of ['linux', 'win32'] as const) {
        expect(await defaultDataDirRoots({ XDG_CONFIG_HOME: '  ' }, home, platform)).toEqual([
          path.join(config, 'openvern'),
          path.join(config, 'openvern'),
        ]);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('combines macOS and XDG roots, canonicalizes existing roots and deduplicates', async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'roots-')));
    try {
      const app = path.join(home, 'Library', 'Application Support');
      const xdg = path.join(home, 'xdg');
      expect(await defaultDataDirRoots({}, home, 'darwin')).toEqual([
        path.join(app, 'openvern'),
        path.join(app, 'harness'),
        path.join(home, '.config', 'openvern'),
        path.join(home, '.config', 'harness'),
      ]);
      await mkdir(path.join(home, 'real', 'openvern'), { recursive: true });
      await mkdir(path.dirname(app), { recursive: true });
      await symlink(path.join(home, 'real'), app);
      expect(await defaultDataDirRoots({ XDG_CONFIG_HOME: xdg }, home, 'darwin')).toEqual([
        path.join(home, 'real', 'openvern'),
        path.join(app, 'harness'),
        path.join(xdg, 'openvern'),
        path.join(xdg, 'harness'),
      ]);
      expect(await defaultDataDirRoots({ XDG_CONFIG_HOME: app }, home, 'darwin')).toEqual([
        path.join(home, 'real', 'openvern'),
        path.join(app, 'harness'),
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

it('denies tools access to both macOS and retained config roots', async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'roots-tools-')));
  try {
    const roots = ['Library/Application Support/openvern', '.config/openvern'];
    for (const [i, root] of roots.entries()) {
      await mkdir(path.join(home, root), { recursive: true });
      await writeFile(path.join(home, root, 'note.txt'), 'hidden sentinel');
      await symlink(path.join(home, root), path.join(home, `alias${i}`));
    }
    await writeFile(path.join(home, 'control.txt'), 'ordinary control');
    const changes = createFakeChangesService();
    const context = {
      projectRoot: home,
      signal: new AbortController().signal,
      changes: changes.tools({ chatId: 'c', projectRoot: home, messageId: 'm' }),
    };
    const projectTools = getProjectTools({ deniedRoots: await defaultDataDirRoots({}, home, 'darwin') });
    const runTool = (name: string, args: unknown) => {
      const tool = projectTools.find((t) => t.spec.name === name);
      if (!tool) throw new Error(name);
      return tool.run(args, context);
    };
    for (const root of [...roots, 'alias0', 'alias1']) {
      for (const [name, args] of [
        ['read_file', { path: `${root}/note.txt` }],
        ['list_files', { path: root }],
        ['search', { path: root, query: 'sentinel' }],
        ['edit_file', { path: `${root}/note.txt`, old_string: 'hidden', new_string: 'changed' }],
        ['write_file', { path: `${root}/new.txt`, content: 'changed' }],
        ['delete_file', { path: `${root}/note.txt` }],
      ] as const) {
        const result = await runTool(name, args);
        expect(result.ok, `${name} ${root}`).toBe(false);
        expect(result.output).not.toContain('hidden sentinel');
      }
    }
    expect(changes.pending.get('c')?.size ?? 0).toBe(0);
    for (const root of roots) expect(await readFile(path.join(home, root, 'note.txt'), 'utf8')).toBe('hidden sentinel');
    expect((await runTool('read_file', { path: 'control.txt' })).ok).toBe(true);
    expect((await runTool('list_files', { path: '.' })).output).toContain('control.txt');
    expect((await runTool('search', { query: 'ordinary' })).output).toContain('control.txt');
    expect(
      (await runTool('edit_file', { path: 'control.txt', old_string: 'ordinary', new_string: 'changed' })).ok,
    ).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
