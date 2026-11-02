import { readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getProjectTools } from './index';
import { createFakeChangesService } from './test-changes';
import { createFixture, type Fixture, write } from './test-fixture';
import type { ToolContext } from './types';

let fx: Fixture;
const changesSvc = createFakeChangesService();
let ctx: ToolContext;

beforeAll(async () => {
  fx = await createFixture();
  await write(fx.root, 'crlf.txt', 'one\r\ntwo\r\nthree\r\n');
  await write(fx.root, 'dup.txt', 'foo\nbar\nfoo\nbaz\nfoo\n');
  await write(fx.root, 'secret.ts', 'const k = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789abcdef";\nconst x = 1;\n');
  await symlink(fx.outside, path.join(fx.root, 'out-link'));
});
afterAll(async () => {
  await fx.cleanup();
});
beforeEach(() => {
  changesSvc.pending.clear();
  ctx = {
    projectRoot: fx.root,
    signal: new AbortController().signal,
    changes: changesSvc.tools({ chatId: 'c1', projectRoot: fx.root, messageId: 'm1' }),
  };
});

const tool = (name: string) => {
  const t = getProjectTools().find((x) => x.spec.name === name);
  if (!t) throw new Error(name);
  return t;
};
const edit = (args: unknown, c: ToolContext = ctx) => tool('edit_file').run(args, c);
const writeFile = (args: unknown, c: ToolContext = ctx) => tool('write_file').run(args, c);
const del = (args: unknown, c: ToolContext = ctx) => tool('delete_file').run(args, c);
const read = (args: unknown) => tool('read_file').run(args, ctx);
const diskOf = (rel: string) => readFile(path.join(fx.root, rel), 'utf8');

describe('edit_file', () => {
  it('stages a replacement, shows a diff excerpt and leaves the disk alone', async () => {
    const r = await edit({ path: 'src/index.ts', old_string: "'Hello World'", new_string: "'Hi'" });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('src/index.ts');
    expect(r.output).toContain('Proposed edit to src/index.ts: +1 -1');
    expect(r.output).toContain("-export const greeting = 'Hello World';");
    expect(r.output).toContain("+export const greeting = 'Hi';");
    expect(r.output).toContain('Proposed, not written yet.');
    expect(await diskOf('src/index.ts')).toContain('Hello World');
  });

  it('can edit the same file twice (reads through its own proposal)', async () => {
    await edit({ path: 'src/index.ts', old_string: 'Hello World', new_string: 'Hi' });
    const r = await edit({ path: 'src/index.ts', old_string: 'Hi', new_string: 'Yo' });
    expect(r.ok).toBe(true);
    expect((await ctx.changes?.read('src/index.ts')) as { content: string }).toMatchObject({
      content: expect.stringContaining("'Yo'"),
    });
  });

  it('errors: bad args, identical strings, empty old_string, missing file, no match', async () => {
    expect((await edit({ path: 'src/index.ts' })).output).toMatch(/Invalid arguments/);
    expect((await edit({ path: 'src/index.ts', old_string: 'a', new_string: 'a' })).output).toMatch(/identical/);
    expect((await edit({ path: 'src/index.ts', old_string: '', new_string: 'a' })).output).toMatch(/write_file/);
    expect((await edit({ path: 'nope.ts', old_string: 'a', new_string: 'b' })).output).toMatch(
      /File not found.*write_file/,
    );
    const r = await edit({ path: 'src/index.ts', old_string: 'does not exist', new_string: 'b' });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not found in src\/index.ts.*Re-read.*whitespace/s);
    expect(changesSvc.pending.get('c1')?.size ?? 0).toBe(0);
  });

  it('multiple matches need replace_all and name their lines', async () => {
    const r = await edit({ path: 'dup.txt', old_string: 'foo', new_string: 'qux' });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/matches 3 places.*lines 1, 3, 5/);
    const all = await edit({ path: 'dup.txt', old_string: 'foo', new_string: 'qux', replace_all: true });
    expect(all.ok).toBe(true);
    expect(all.output).toContain('(3 replacements)');
    const staged = await ctx.changes?.read('dup.txt');
    expect(staged).toEqual({ kind: 'staged', content: 'qux\nbar\nqux\nbaz\nqux\n' });
  });

  it('matches LF input against a CRLF file and keeps CRLF', async () => {
    const r = await edit({ path: 'crlf.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' });
    expect(r.ok).toBe(true);
    expect(await ctx.changes?.read('crlf.txt')).toEqual({ kind: 'staged', content: 'uno\r\ndos\r\nthree\r\n' });
  });

  it('refuses redaction placeholders and secrets it cannot match', async () => {
    const p = await edit({ path: 'src/index.ts', old_string: 'greeting', new_string: '«redacted:key»' });
    expect(p.ok).toBe(false);
    expect(p.output).toMatch(/placeholder/);
    const m = await edit({ path: 'src/index.ts', old_string: '«redacted:key»', new_string: 'x' });
    expect(m.output).toMatch(/placeholder/);
    const s = await edit({ path: 'secret.ts', old_string: 'const k = "«redacted:key»"', new_string: 'x' });
    expect(s.ok).toBe(false);
    const around = await edit({ path: 'secret.ts', old_string: 'const x = 1;', new_string: 'const x = 2;' });
    expect(around.ok).toBe(true);
  });

  it('refuses binary files, directories and oversized results', async () => {
    expect((await edit({ path: 'bin/blob.bin', old_string: 'a', new_string: 'b' })).output).toMatch(/binary/);
    expect((await edit({ path: 'src', old_string: 'a', new_string: 'b' })).output).toMatch(/directory/);
    const big = await edit({
      path: 'src/index.ts',
      old_string: 'Hello World',
      new_string: 'x'.repeat(LIMITS.writeFileMaxBytes + 1),
    });
    expect(big.output).toMatch(/limit/);
  });

  it('refuses a proposed deletion target and says to use write_file', async () => {
    await del({ path: 'src/index.ts' });
    const r = await edit({ path: 'src/index.ts', old_string: 'a', new_string: 'b' });
    expect(r.output).toMatch(/proposed for deletion.*write_file/);
  });

  it('edits a file created earlier in the same proposal', async () => {
    await writeFile({ path: 'src/new.ts', content: 'export const n = 1;\n' });
    const r = await edit({ path: 'src/new.ts', old_string: 'n = 1', new_string: 'n = 2' });
    expect(r.ok).toBe(true);
    expect(await ctx.changes?.read('src/new.ts')).toEqual({ kind: 'staged', content: 'export const n = 2;\n' });
  });

  it('reports a no-op edit that restores the disk content', async () => {
    await edit({ path: 'src/index.ts', old_string: 'Hello World', new_string: 'Hi' });
    const r = await edit({ path: 'src/index.ts', old_string: 'Hi', new_string: 'Hello World' });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/no change is proposed/);
    expect(changesSvc.pending.get('c1')?.size).toBe(0);
  });
});

describe('write_file', () => {
  it('proposes a new file, including in a folder that does not exist yet', async () => {
    const r = await writeFile({ path: 'src/deep/er/new.ts', content: 'a\nb\n' });
    expect(r.ok).toBe(true);
    expect(r.output).toBe('Proposed new file src/deep/er/new.ts (2 lines). Proposed, not written yet.');
    await expect(diskOf('src/deep/er/new.ts')).rejects.toThrow();
  });

  it('overwrites an existing file with a diff excerpt', async () => {
    const r = await writeFile({ path: 'README.md', content: '# Changed\n\nA tiny project.\n' });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('Proposed edit to README.md');
    expect(r.output).toContain('-# Fixture');
    expect(r.output).toContain('+# Changed');
  });

  it('says so when the content is unchanged', async () => {
    const r = await writeFile({ path: 'README.md', content: await diskOf('README.md') });
    expect(r.output).toMatch(/^No change/);
  });

  it('caps the size, refuses placeholders and NUL bytes, and binary targets', async () => {
    expect((await writeFile({ path: 'a.txt', content: 'x'.repeat(LIMITS.writeFileMaxBytes + 1) })).output).toMatch(
      /limit/,
    );
    expect((await writeFile({ path: 'a.txt', content: 'key «redacted:api» end' })).output).toMatch(/edit_file/);
    expect((await writeFile({ path: 'a.txt', content: 'a\0b' })).ok).toBe(false);
    expect((await writeFile({ path: 'bin/blob.bin', content: 'text' })).output).toMatch(/binary/);
  });

  it('can recreate a file proposed for deletion', async () => {
    await del({ path: 'README.md' });
    const r = await writeFile({ path: 'README.md', content: '# Again\n' });
    expect(r.ok).toBe(true);
  });
});

describe('delete_file', () => {
  it('stages a deletion and reports the size', async () => {
    const r = await del({ path: 'README.md' });
    expect(r.output).toBe('Proposed deleting README.md (3 lines). Proposed, not written yet.');
    expect(await diskOf('README.md')).toContain('Fixture');
    expect((await del({ path: 'README.md' })).output).toMatch(/already proposed/);
  });

  it('allows deleting binary files; refuses directories and missing files', async () => {
    expect((await del({ path: 'bin/blob.bin' })).output).toContain('binary file');
    expect((await del({ path: 'src' })).output).toMatch(/directory/);
    expect((await del({ path: 'nothing.txt' })).output).toMatch(/File not found/);
  });

  it('dropping a created file removes it from the proposal', async () => {
    await writeFile({ path: 'tmp.txt', content: 'x' });
    const r = await del({ path: 'tmp.txt' });
    expect(r.ok).toBe(true);
    expect(changesSvc.pending.get('c1')?.size).toBe(0);
  });
});

describe('sandbox (all edit tools)', () => {
  const cases: [string, string][] = [
    ['.env', 'blocked'],
    ['.env.local', 'blocked'],
    ['.git/config', 'blocked'],
    ['certs/new.pem', 'blocked'],
    ['../outside/x.txt', 'outside'],
    ['/etc/passwd', 'outside'],
    ['link-env', 'blocked'],
    ['link-out-file', 'outside'],
    ['link-out-dir/new.txt', 'outside'],
    ['out-link/new.txt', 'outside'],
    ['secrets.json', 'blocked'],
  ];
  for (const [p, why] of cases) {
    it(`refuses ${p}`, async () => {
      for (const r of [
        await writeFile({ path: p, content: 'x' }),
        await edit({ path: p, old_string: 'a', new_string: 'b' }),
        await del({ path: p }),
      ]) {
        expect(r.ok).toBe(false);
        expect(r.output).toMatch(why === 'blocked' ? /blocked/ : /outside/);
      }
      expect(changesSvc.pending.get('c1')?.size ?? 0).toBe(0);
    });
  }

  it('refuses when no change set is attached (loose chat)', async () => {
    const bare: ToolContext = { projectRoot: fx.root, signal: ctx.signal };
    for (const r of [
      await writeFile({ path: 'a.txt', content: 'x' }, bare),
      await edit({ path: 'README.md', old_string: 'a', new_string: 'b' }, bare),
      await del({ path: 'README.md' }, bare),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/not available/);
    }
  });

  it('honours an already-aborted signal', async () => {
    const aborted: ToolContext = { ...ctx, signal: AbortSignal.abort() };
    expect((await writeFile({ path: 'a.txt', content: 'x' }, aborted)).output).toMatch(/Cancelled/);
    expect(changesSvc.pending.get('c1')?.size ?? 0).toBe(0);
  });

  it('turns a stage failure into a message', async () => {
    const { CoreError } = await import('../errors');
    const failing: ToolContext = {
      ...ctx,
      changes: {
        read: async () => null,
        staged: async () => [],
        stage: async () => {
          throw new CoreError('invalid_request', 'Too many proposed files.');
        },
      },
    };
    const r = await writeFile({ path: 'a.txt', content: 'x' }, failing);
    expect(r).toMatchObject({ ok: false, output: 'Too many proposed files.' });
  });
});

describe('read tools see the proposal (overlay)', () => {
  it('read_file shows staged content with a header note, hides deleted files', async () => {
    await edit({ path: 'src/index.ts', old_string: 'Hello World', new_string: 'Hi' });
    const r = await read({ path: 'src/index.ts' });
    expect(r.output).toContain("export const greeting = 'Hi';");
    expect(r.output.split('\n')[0]).toBe('src/index.ts (lines 1-5 of 5) (proposed version, not on disk yet)');
    await writeFile({ path: 'src/made.ts', content: 'hello\n' });
    expect((await read({ path: 'src/made.ts' })).output).toContain('1 | hello');
    await del({ path: 'README.md' });
    const gone = await read({ path: 'README.md' });
    expect(gone.ok).toBe(false);
    expect(gone.output).toMatch(/proposed for deletion/);
    // unproposed files are unchanged
    expect((await read({ path: 'src/util.test.ts' })).output).not.toContain('proposed version');
  });

  it('list_files shows created files and hides deleted ones', async () => {
    await writeFile({ path: 'src/made.ts', content: 'x\n' });
    await writeFile({ path: 'fresh/inner/a.ts', content: 'x\n' });
    await del({ path: 'README.md' });
    const r = await tool('list_files').run({ path: '.', depth: 3 }, ctx);
    expect(r.output).toContain('made.ts');
    expect(r.output).toContain('fresh/\n  inner/\n    a.ts');
    expect(r.output).not.toContain('README.md');
    const sub = await tool('list_files').run({ path: 'fresh' }, ctx);
    expect(sub.ok).toBe(true);
    expect(sub.output).toContain('inner/');
    const without = await tool('list_files').run({ path: '.', depth: 3 }, { ...ctx, changes: undefined });
    expect(without.output).toContain('README.md');
    expect(without.output).not.toContain('made.ts');
  });

  it('search finds staged text, new files and skips deleted files', async () => {
    await edit({ path: 'src/index.ts', old_string: 'Hello World', new_string: 'Zebra' });
    await writeFile({ path: 'src/made.ts', content: 'a zebra here\n' });
    await del({ path: 'README.md' });
    const r = await tool('search').run({ query: 'zebra' }, ctx);
    expect(r.output).toContain("src/index.ts:1: export const greeting = 'Zebra';");
    expect(r.output).toContain('src/made.ts:1: a zebra here');
    expect((await tool('search').run({ query: 'Hello World' }, ctx)).output).toMatch(/No matches/);
    expect((await tool('search').run({ query: 'tiny project' }, ctx)).output).toMatch(/No matches/);
    const scoped = await tool('search').run({ query: 'zebra', path: 'src/made.ts' }, ctx);
    expect(scoped.output).toContain('src/made.ts:1');
  });
});
