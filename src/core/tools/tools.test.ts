import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProjectTools, renderTree } from './index';
import { createFixture, type Fixture, write } from './test-fixture';
import type { Tool, ToolContext } from './types';

let fx: Fixture;
beforeAll(async () => {
  fx = await createFixture();
});
afterAll(async () => {
  await fx.cleanup();
});

function tool(name: string): Tool {
  const t = getProjectTools().find((x) => x.spec.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
const listFiles = (args: unknown, ctx: ToolContext = fx.ctx) => tool('list_files').run(args, ctx);
const readFile = (args: unknown, ctx: ToolContext = fx.ctx) => tool('read_file').run(args, ctx);
const search = (args: unknown, ctx: ToolContext = fx.ctx) => tool('search').run(args, ctx);
const abortedCtx = (): ToolContext => ({ projectRoot: fx.root, signal: AbortSignal.abort() });

describe('getProjectTools', () => {
  it('exposes the read and edit tools with clean JSON Schema parameters', () => {
    const tools = getProjectTools();
    expect(tools.map((t) => t.spec.name)).toEqual([
      'list_files',
      'read_file',
      'search',
      'edit_file',
      'write_file',
      'delete_file',
    ]);
    for (const t of tools) {
      expect(t.spec.description.length).toBeGreaterThan(50);
      expect(t.spec.parameters.type).toBe('object');
      expect(t.spec.parameters).not.toHaveProperty('$schema');
      expect(JSON.parse(JSON.stringify(t.spec.parameters))).toEqual(t.spec.parameters);
    }
    expect(tool('read_file').spec.parameters.required).toEqual(['path']);
    expect(tool('search').spec.parameters.required).toEqual(['query']);
    expect(tool('list_files').spec.parameters.required).toBeUndefined();
  });

  it('never throws on garbage arguments', async () => {
    for (const t of getProjectTools()) {
      for (const args of [null, undefined, 42, 'x', [], { path: 5 }, { query: {} }]) {
        const res = await t.run(args, fx.ctx);
        expect(typeof res.output).toBe('string');
        expect(typeof res.summary).toBe('string');
      }
    }
    expect((await readFile({})).ok).toBe(false);
    expect((await readFile({})).output).toContain('path');
    expect((await listFiles({ depth: 9 })).output).toContain('depth');
    expect((await search({ query: '' })).ok).toBe(false);
  });
});

describe('list_files', () => {
  it('renders an indented tree with directories suffixed by /', async () => {
    const res = await listFiles({});
    expect(res.ok).toBe(true);
    expect(res.summary).toBe('.');
    const lines = res.output.split('\n');
    expect(lines[0]).toBe('./ (depth 2)');
    expect(lines).toContain('src/');
    expect(lines).toContain('  components/');
    expect(lines).toContain('  index.ts');
    expect(lines).toContain('README.md');
    // depth 2: contents of src/components are not shown
    expect(res.output).not.toContain('Button.tsx');
  });

  it('respects depth and path', async () => {
    const deep = await listFiles({ path: '.', depth: 3 });
    expect(deep.output).toContain('    Button.tsx');
    const sub = await listFiles({ path: 'src', depth: 1 });
    expect(sub.summary).toBe('src');
    expect(sub.output.split('\n')[0]).toBe('src/ (depth 1)');
    expect(sub.output).toContain('index.ts');
    expect(sub.output).not.toContain('Button.tsx');
  });

  it('always skips build/dependency directories, ignores, secrets and .git', async () => {
    const res = await listFiles({ depth: 5 });
    for (const name of [
      'node_modules',
      'dist',
      'build',
      'out/',
      '.next',
      '.turbo',
      '.cache',
      'coverage',
      'target',
      '.venv',
      'venv',
      '__pycache__',
      '.git/',
    ]) {
      expect(res.output.split('\n')).not.toContain(name);
    }
    expect(res.output).not.toMatch(/^\s*\.git\/?$/m);
    expect(res.output).not.toContain('debug.log');
    expect(res.output).not.toContain('secret-dir');
    expect(res.output).not.toMatch(/^\s*\.env$/m);
    expect(res.output).not.toContain('.env.local');
    expect(res.output).not.toContain('server.pem');
    expect(res.output).not.toContain('id_rsa');
    expect(res.output).toContain('.env.example');
    expect(res.output).toContain('.env.sample');
    expect(res.output).toContain('.gitignore');
  });

  it('honours nested .gitignore files, including negation in a deeper file', async () => {
    const res = await listFiles({ path: 'src/nested' });
    expect(res.output).toContain('a.ts');
    expect(res.output).toContain('keep.log'); // root ignores *.log, nested un-ignores it
    expect(res.output).not.toContain('generated.ts');
    // ancestors' .gitignore applies when starting below the root
    const fromBelow = await listFiles({ path: 'secret-dir' });
    expect(fromBelow.ok).toBe(true); // explicit request for an ignored dir is honoured
  });

  it('marks symlinks with @ and never follows them', async () => {
    const res = await listFiles({ depth: 3 });
    expect(res.output).toContain('link-out-dir@');
    expect(res.output).not.toContain('inner.txt');
  });

  it('reports truncation and prefers shallow entries', async () => {
    const root = path.join(fx.root, 'many');
    await mkdir(root);
    for (let i = 0; i < LIMITS.listFilesMaxEntries + 20; i++)
      await write(root, `f${String(i).padStart(4, '0')}.txt`, 'x');
    await write(fx.root, 'zzz-last/deep/file.txt', 'x');
    const res = await listFiles({ path: '.', depth: 5 });
    expect(res.ok).toBe(true);
    expect(res.output).toContain(`truncated: showing the first ${LIMITS.listFilesMaxEntries} entries`);
    expect(res.output.split('\n').length).toBeLessThanOrEqual(LIMITS.listFilesMaxEntries + 3);
    const many = await listFiles({ path: 'many' });
    expect(many.output).toContain('truncated');
    expect(many.output).toContain('f0000.txt');
    expect(many.output).not.toContain(`f${LIMITS.listFilesMaxEntries + 19}.txt`);
  });

  it('fails helpfully', async () => {
    expect(await listFiles({ path: '../outside' })).toMatchObject({ ok: false, output: 'Path is outside the project' });
    expect(await listFiles({ path: 'link-out-dir' })).toMatchObject({
      ok: false,
      output: 'Path is outside the project',
    });
    expect(await listFiles({ path: '.git' })).toMatchObject({ ok: false, output: 'Access to this file is blocked' });
    expect(await listFiles({ path: 'nope' })).toMatchObject({ ok: false });
    expect((await listFiles({ path: 'nope' })).output).toContain('not found');
    expect((await listFiles({ path: 'README.md' })).output).toContain('Not a directory');
  });

  it('lists an empty directory', async () => {
    await mkdir(path.join(fx.root, 'emptydir'));
    expect((await listFiles({ path: 'emptydir' })).output).toContain('(empty)');
  });

  it('stops when aborted', async () => {
    const res = await listFiles({}, abortedCtx());
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/cancel/i);
  });
});

describe('read_file', () => {
  it('returns numbered lines with a header', async () => {
    const res = await readFile({ path: 'src/index.ts' });
    expect(res.ok).toBe(true);
    expect(res.summary).toBe('src/index.ts');
    expect(res.output).toBe(
      [
        'src/index.ts (lines 1-5 of 5)',
        "1 | export const greeting = 'Hello World';",
        '2 | // TODO: fix this',
        '3 | export function main() {',
        '4 |   return greeting;',
        '5 | }',
      ].join('\n'),
    );
  });

  it('supports line ranges and puts the range in the summary', async () => {
    const res = await readFile({ path: 'lines.txt', start_line: 10, end_line: 12 });
    expect(res.output).toBe(
      [
        'lines.txt (lines 10-12 of 3000)',
        '10 | line 10',
        '11 | line 11',
        '12 | line 12',
        '... 2988 more line(s) in the file. Continue with start_line=13.',
      ].join('\n'),
    );
    expect(res.summary).toBe('lines.txt (lines 10-12)');
    const tail = await readFile({ path: 'lines.txt', start_line: 2999, end_line: 5000 });
    expect(tail.output).toBe(
      ['lines.txt (lines 2999-3000 of 3000)', '2999 | line 2999', '3000 | line 3000'].join('\n'),
    );
  });

  it('caps at readFileMaxLines and says how to continue', async () => {
    const res = await readFile({ path: 'lines.txt' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain(`lines 1-${LIMITS.readFileMaxLines} of 3000`);
    expect(res.output).toContain(
      `output cut at ${LIMITS.readFileMaxLines} lines. Continue with start_line=${LIMITS.readFileMaxLines + 1}.`,
    );
    expect(res.output).not.toContain('line 2001');
  });

  it('caps at readFileMaxBytes', async () => {
    await write(
      fx.root,
      'wide.txt',
      `${Array.from({ length: 400 }, (_, i) => `${i} ${'w'.repeat(500)}`).join('\n')}\n`,
    );
    const res = await readFile({ path: 'wide.txt' });
    expect(res.ok).toBe(true);
    expect(res.output.length).toBeLessThan(LIMITS.readFileMaxBytes + 1000);
    expect(res.output).toMatch(/output cut at 100 KB\. Continue with start_line=\d+\./);
    const next = Number(/start_line=(\d+)/.exec(res.output)?.[1]);
    const cont = await readFile({ path: 'wide.txt', start_line: next });
    expect(cont.ok).toBe(true);
    expect(cont.output).toContain(`${next} | ${next - 1} `);
  });

  it('returns the start of a single enormous line', async () => {
    await write(fx.root, 'minified.js', `${'a'.repeat(300 * 1024)}\n`);
    const res = await readFile({ path: 'minified.js' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('[line cut]');
    expect(res.output.length).toBeLessThan(LIMITS.readFileMaxBytes + 1000);
  });

  it.each([
    ['CJK (3-byte)', '漢'],
    ['emoji (4-byte)', '😀'],
  ])('cuts a single enormous %s line by bytes without splitting a code point', async (_name, ch) => {
    await write(fx.root, 'multibyte.txt', `${ch.repeat(200 * 1024)}\n`);
    const res = await readFile({ path: 'multibyte.txt' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('[line cut]');
    expect(Buffer.byteLength(res.output)).toBeLessThanOrEqual(LIMITS.readFileMaxBytes);
    expect(res.output).not.toContain('\uFFFD');
    expect(res.output).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('handles empty files, CRLF and missing trailing newline', async () => {
    expect((await readFile({ path: 'empty.txt' })).output).toBe('empty.txt (empty file, 0 lines)');
    await write(fx.root, 'crlf.txt', 'a\r\nb\r\nc');
    expect((await readFile({ path: 'crlf.txt' })).output).toBe(
      ['crlf.txt (lines 1-3 of 3)', '1 | a', '2 | b', '3 | c'].join('\n'),
    );
  });

  it('rejects binary files', async () => {
    const res = await readFile({ path: 'bin/blob.bin' });
    expect(res.ok).toBe(false);
    expect(res.output.startsWith('Binary file')).toBe(true);
  });

  it('rejects bad ranges', async () => {
    expect((await readFile({ path: 'src/index.ts', start_line: 99 })).output).toContain(
      'past the end of the file (5 lines)',
    );
    expect((await readFile({ path: 'src/index.ts', start_line: 4, end_line: 2 })).ok).toBe(false);
    expect((await readFile({ path: 'src/index.ts', start_line: 0 })).ok).toBe(false);
    expect((await readFile({ path: 'src/index.ts', start_line: 1.5 })).ok).toBe(false);
  });

  it('blocks traversal, symlink escapes and secrets', async () => {
    for (const p of [
      '../outside/secret.txt',
      '/etc/passwd',
      'link-out-file',
      'link-out-dir/inner.txt',
      'src/../../outside/secret.txt',
    ]) {
      expect(await readFile({ path: p })).toMatchObject({ ok: false, output: 'Path is outside the project' });
    }
    for (const p of ['.env', '.env.local', 'certs/server.pem', 'ssh/id_rsa', '.git/config', 'link-env']) {
      expect(await readFile({ path: p })).toMatchObject({ ok: false, output: 'Access to this file is blocked' });
    }
  });

  it('allows .env.example and in-project symlinks', async () => {
    expect((await readFile({ path: '.env.example' })).output).toContain('needle-example');
    expect((await readFile({ path: 'link-in' })).output).toContain('src/index.ts (lines 1-5 of 5)');
  });

  it('reads files in ignored directories when asked explicitly', async () => {
    expect((await readFile({ path: 'node_modules/pkg/index.js' })).ok).toBe(true);
  });

  it('fails helpfully on directories and missing files', async () => {
    expect((await readFile({ path: 'src' })).output).toContain('is a directory');
    expect((await readFile({ path: 'src/missing.ts' })).output).toContain('File not found');
  });

  it('stops when aborted', async () => {
    const res = await readFile({ path: 'src/index.ts' }, abortedCtx());
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/cancel/i);
  });
});

describe('search', () => {
  it('finds literal matches case-insensitively as path:line: text', async () => {
    const res = await search({ query: 'hello world' });
    expect(res.ok).toBe(true);
    expect(res.output).toBe("src/index.ts:1: export const greeting = 'Hello World';");
    expect(res.summary).toBe('"hello world" in .');
  });

  it('is literal by default, so regex characters are plain text', async () => {
    await write(fx.root, 'notes/regex.txt', 'price is $5.00 (approx)\nprice is 5x00\n');
    const lit = await search({ query: '$5.00 (approx)' });
    expect(lit.output).toBe('notes/regex.txt:1: price is $5.00 (approx)');
    const asRegex = await search({ query: '5.00', is_regex: true, path: 'notes' });
    expect(asRegex.output.split('\n')).toEqual([
      'notes/regex.txt:1: price is $5.00 (approx)',
      'notes/regex.txt:2: price is 5x00',
    ]);
    const dot = await search({ query: '5.00', path: 'notes' });
    expect(dot.output.split('\n')).toHaveLength(1);
  });

  it('supports regex mode, case-insensitive, anchors per line', async () => {
    const res = await search({ query: '^export (const|function) \\w+', is_regex: true, path: 'src' });
    expect(res.ok).toBe(true);
    expect(res.output.split('\n')).toContain('src/index.ts:3: export function main() {');
    expect(res.output).toContain('src/index.ts:1:');
    const ci = await search({ query: 'TODO: FIX', is_regex: true });
    expect(ci.output).toBe('src/index.ts:2: // TODO: fix this');
  });

  it('reports an invalid regex', async () => {
    const res = await search({ query: '(unclosed', is_regex: true });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('Invalid regular expression');
  });

  it('skips ignored dirs, .gitignore matches, secrets, binaries, big files and symlinks', async () => {
    const res = await search({ query: 'needle' });
    expect(res.ok).toBe(true);
    const files = new Set(res.output.split('\n').map((l) => l.split(':')[0]));
    expect([...files].sort()).toEqual([
      '.env.example',
      '.env.sample',
      'src/components/Button.tsx',
      'src/nested/keep.log',
      'src/util.test.ts',
    ]);
  });

  it('restricts by path (directory or single file)', async () => {
    expect((await search({ query: 'needle', path: 'src/components' })).output).toBe(
      'src/components/Button.tsx:1: export const Button = () => <button>NEEDLE button</button>;',
    );
    expect((await search({ query: 'greeting', path: 'src/index.ts' })).output).toContain('src/index.ts:1:');
    expect((await search({ query: 'needle', path: '../outside' })).output).toBe('Path is outside the project');
    expect((await search({ query: 'needle', path: '.env' })).output).toBe('Access to this file is blocked');
  });

  it('filters with globs', async () => {
    const ts = await search({ query: 'needle', glob: '*.tsx' });
    expect(ts.output.split('\n').map((l) => l.split(':')[0])).toEqual(['src/components/Button.tsx']);
    const braces = await search({ query: 'needle', glob: '*.{tsx,log}' });
    expect(
      braces.output
        .split('\n')
        .map((l) => l.split(':')[0])
        .sort(),
    ).toEqual(['src/components/Button.tsx', 'src/nested/keep.log']);
    const anchored = await search({ query: 'greeting', glob: 'src/*.ts' });
    expect(new Set(anchored.output.split('\n').map((l) => l.split(':')[0]))).toEqual(
      new Set(['src/index.ts', 'src/util.test.ts']),
    );
    const relToPath = await search({ query: 'greeting', path: 'src', glob: '*.test.ts' });
    expect(relToPath.output).toContain('src/util.test.ts');
    expect(relToPath.output).not.toContain('src/index.ts');
    expect((await search({ query: 'needle', glob: '!*.ts' })).output).toContain('Invalid glob');
  });

  it('says so when nothing matches', async () => {
    const res = await search({ query: 'zzz-no-such-thing' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('No matches');
  });

  it('truncates at searchMaxMatches and says how to narrow', async () => {
    const lines = Array.from({ length: LIMITS.searchMaxMatches + 50 }, (_, i) => `repeat ${i}`).join('\n');
    await write(fx.root, 'repeat/a.txt', lines);
    await write(fx.root, 'repeat/b.txt', lines);
    const res = await search({ query: 'repeat', path: 'repeat' });
    expect(res.ok).toBe(true);
    const out = res.output.split('\n');
    expect(out).toHaveLength(LIMITS.searchMaxMatches + 1);
    expect(out[out.length - 1]).toContain(`truncated at ${LIMITS.searchMaxMatches} matches`);
  });

  it('clips very long lines', async () => {
    await write(fx.root, 'long/l.txt', `needle-long ${'z'.repeat(1000)}\n`);
    const res = await search({ query: 'needle-long', path: 'long' });
    expect(res.output.length).toBeLessThan(400);
    expect(res.output.endsWith('...')).toBe(true);
  });

  it('stops when aborted', async () => {
    const res = await search({ query: 'needle' }, abortedCtx());
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/cancel/i);
  });

  it('stops mid-walk when aborted during the search', async () => {
    const ac = new AbortController();
    const p = search({ query: 'needle' }, { projectRoot: fx.root, signal: ac.signal });
    ac.abort();
    const res = await p;
    expect(res.ok).toBe(false);
  });
});

describe('renderTree', () => {
  it('renders the project tree for the system prompt', async () => {
    const tree = await renderTree(fx.root, { depth: 1, maxEntries: 500 });
    const lines = tree.split('\n');
    expect(lines).toContain('src/');
    expect(lines).toContain('README.md');
    expect(lines).not.toContain('node_modules/');
    expect(tree).not.toContain('index.ts');
  });

  it('truncates at maxEntries with a note', async () => {
    const tree = await renderTree(fx.root, { depth: 3, maxEntries: 5 });
    expect(tree.split('\n')).toHaveLength(6);
    expect(tree).toContain('truncated: showing the first 5 entries');
  });

  it('returns promptly with nothing listed when the signal is already aborted', async () => {
    const tree = await renderTree(fx.root, { depth: 2, maxEntries: 500, signal: AbortSignal.abort() });
    expect(tree).not.toContain('src/');
    expect(tree).not.toContain('README.md');
  });

  it('does not throw for a missing root', async () => {
    expect(await renderTree(path.join(fx.root, 'nope'), { depth: 2, maxEntries: 10 })).toMatch(/not readable/);
  });
});
