import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as wording from '../agent/edit-mode';
import { createChangesService } from '../changes';
import type { ChangesService } from '../types';
import { getProjectTools } from './index';
import { createFixture, type Fixture, write } from './test-fixture';

let fx: Fixture;
let data: string;
let svc: ChangesService;
let run: (name: string, args: Record<string, unknown>) => ReturnType<ReturnType<typeof getProjectTools>[number]['run']>;
beforeEach(async () => {
  fx = await createFixture();
  data = await mkdtemp(path.join(tmpdir(), 'auto-test-'));
  svc = createChangesService({ dataDir: data });
  const changes = svc.tools({
    chatId: 'c',
    projectId: 'p',
    projectRoot: fx.root,
    messageId: 'm',
    turnId: 't',
    mode: 'auto',
  });
  const ctx = { ...fx.ctx, changes };
  run = (name, args) => {
    const tool = getProjectTools({ editMode: 'auto' }).find((t) => t.spec.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.run(args, ctx);
  };
});
afterEach(async () => {
  await fx.cleanup();
  await rm(data, { recursive: true, force: true });
});

describe('Auto edit tools with real changes', () => {
  it('edits, creates and deletes files on disk', async () => {
    const edit = await run('edit_file', { path: 'README.md', old_string: '# Fixture', new_string: '# Changed' });
    expect(edit.ok).toBe(true);
    expect(edit.output).toBe(
      'Wrote edit to README.md: +1 -1\n@@ -1,3 +1,3 @@\n-# Fixture\n+# Changed\n \n A tiny project.\nWritten to disk.',
    );
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toContain('# Changed');
    const created = await run('write_file', { path: 'new.txt', content: 'hello\n' });
    expect(created.ok).toBe(true);
    expect(created.output).toBe('Created new.txt (1 line). Written to disk.');
    expect(await readFile(path.join(fx.root, 'new.txt'), 'utf8')).toBe('hello\n');
    const deleted = await run('delete_file', { path: 'new.txt' });
    expect(deleted.ok).toBe(true);
    expect(deleted.output).toBe('Deleted new.txt (1 line). The user can undo this turn.');
    await expect(readFile(path.join(fx.root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires a read before overwriting and permits it after reading', async () => {
    const args = { path: 'README.md', content: 'replacement\n' };
    const refused = await run('write_file', args);
    expect(refused.ok).toBe(false);
    expect(refused.output).toBe(wording.autoUnreadText('README.md'));
    expect((await run('read_file', { path: 'README.md' })).ok).toBe(true);
    expect((await run('write_file', args)).ok).toBe(true);
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toBe('replacement\n');
  });
  it('refuses stale reads and leaves the user edit intact', async () => {
    await run('read_file', { path: 'README.md' });
    await write(fx.root, 'README.md', 'user edit\n');
    const result = await run('write_file', { path: 'README.md', content: 'replacement' });
    expect(result.ok).toBe(false);
    expect(result.output).toBe(wording.autoStaleText('README.md'));
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toBe('user edit\n');
  });
  it('reports a no-op write', async () => {
    await run('read_file', { path: 'README.md' });
    const content = await readFile(path.join(fx.root, 'README.md'), 'utf8');
    const result = await run('write_file', { path: 'README.md', content });
    expect(result.ok).toBe(true);
    expect(result.output).toBe(wording.autoNoChangeText('README.md'));
    expect(await svc.get('c')).toEqual({ pending: null, applied: [], diskSeq: 0 });
  });
});

describe('Auto refusal boundaries and read records', () => {
  it.each(['edit_file', 'write_file', 'delete_file'])(
    'refuses %s on a pending proposal without changing it',
    async (name) => {
      const review = svc.tools({
        chatId: 'c',
        projectId: 'p',
        projectRoot: fx.root,
        messageId: 'r',
        turnId: 'r',
        mode: 'review',
      });
      await review.stage('README.md', 'proposed\n');
      const before = await svc.get('c');
      const result = await run(name, {
        path: 'README.md',
        content: 'replacement',
        old_string: 'proposed',
        new_string: 'new',
      });
      expect(result).toMatchObject({ ok: false, output: wording.autoPendingText('README.md') });
      expect(await svc.get('c')).toEqual(before);
      expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toContain('# Fixture');
    },
  );
  it.each(['edit_file', 'write_file', 'delete_file'])('refuses %s on an oversized source', async (name) => {
    const content = 'x'.repeat(LIMITS.editSourceMaxBytes + 1);
    await write(fx.root, 'large.txt', content);
    const result = await run(name, { path: 'large.txt', content: 'small', old_string: 'x', new_string: 'y' });
    expect(result).toMatchObject({ ok: false, output: wording.autoSourceTooLargeText('large.txt') });
    expect(await readFile(path.join(fx.root, 'large.txt'), 'utf8')).toBe(content);
    expect((await svc.get('c')).applied).toEqual([]);
  });
  it('refuses content over the write limit', async () => {
    const content = 'x'.repeat(LIMITS.writeFileMaxBytes + 1);
    expect(await run('write_file', { path: 'new.txt', content })).toMatchObject({
      ok: false,
      output: wording.contentTooLargeText('auto', content.length),
    });
    await expect(readFile(path.join(fx.root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('records a binary read so deletion is allowed', async () => {
    await write(fx.root, 'binary.dat', Buffer.from([0, 1, 2, 255]));
    expect((await run('read_file', { path: 'binary.dat' })).output).toContain('binary');
    expect(await run('delete_file', { path: 'binary.dat' })).toMatchObject({
      ok: true,
      output: 'Deleted binary.dat (binary file). The user can undo this turn.',
    });
    await expect(readFile(path.join(fx.root, 'binary.dat'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reading a pending proposal does not authorize a later overwrite', async () => {
    const review = svc.tools({
      chatId: 'c',
      projectId: 'p',
      projectRoot: fx.root,
      messageId: 'r',
      turnId: 'r',
      mode: 'review',
    });
    await review.stage('README.md', 'proposal\n');
    expect((await run('read_file', { path: 'README.md' })).output).toContain('proposal');
    await svc.discard('c');
    expect(await run('write_file', { path: 'README.md', content: 'overwrite' })).toMatchObject({
      ok: false,
      output: wording.autoUnreadText('README.md'),
    });
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toContain('# Fixture');
  });
  it.each(['edit_file', 'delete_file'])('refuses %s after the read goes stale', async (name) => {
    await run('read_file', { path: 'README.md' });
    const changed = '# Fixture\nuser edit\n';
    await write(fx.root, 'README.md', changed);
    expect(await run(name, { path: 'README.md', old_string: '# Fixture', new_string: '# Model' })).toMatchObject({
      ok: false,
      output: wording.autoStaleText('README.md'),
    });
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toBe(changed);
  });
  it('refuses deleting an unread existing file', async () => {
    expect(await run('delete_file', { path: 'README.md' })).toMatchObject({
      ok: false,
      output: wording.autoUnreadText('README.md'),
    });
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toContain('# Fixture');
  });
});

describe('A failed read records nothing', () => {
  // Each failure must leave the chat's record of README.md as it was: here, the bytes before the user's edit.
  const failures: [string, () => Promise<unknown>][] = [
    ['a start_line past the end of the file', () => run('read_file', { path: 'README.md', start_line: 999 })],
    ['an end_line before start_line', () => run('read_file', { path: 'README.md', start_line: 3, end_line: 2 })],
    [
      'an unreadable file',
      async () => {
        await chmod(path.join(fx.root, 'README.md'), 0o000);
        try {
          return await run('read_file', { path: 'README.md' });
        } finally {
          await chmod(path.join(fx.root, 'README.md'), 0o644);
        }
      },
    ],
  ];
  const cases = failures.flatMap(([what, read]) =>
    (['write_file', 'delete_file'] as const).map((tool) => [what, tool, read] as const),
  );

  it.each(cases)('a read failing on %s does not let %s overwrite the user edit', async (_what, tool, failedRead) => {
    expect((await run('read_file', { path: 'README.md' })).ok).toBe(true);
    const userEdit = '# Fixture\nuser edit\n';
    await write(fx.root, 'README.md', userEdit);
    expect(await failedRead()).toMatchObject({ ok: false });
    expect(await run(tool, { path: 'README.md', content: 'model rewrite\n' })).toMatchObject({
      ok: false,
      output: wording.autoStaleText('README.md'),
    });
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toBe(userEdit);
    expect((await svc.get('c')).applied).toEqual([]);
  });

  it.each(cases)('a read failing on %s does not count as a first read for %s', async (_what, tool, failedRead) => {
    expect(await failedRead()).toMatchObject({ ok: false });
    expect(await run(tool, { path: 'README.md', content: 'model rewrite\n' })).toMatchObject({
      ok: false,
      output: wording.autoUnreadText('README.md'),
    });
    expect(await readFile(path.join(fx.root, 'README.md'), 'utf8')).toContain('# Fixture');
  });
});

describe('a write that reached the disk but not the change history', () => {
  it('is reported as written, plus a line saying Undo covers it only while the app stays open', async () => {
    const changes = {
      ...svc.tools({ chatId: 'c', projectId: 'p', projectRoot: fx.root, messageId: 'm', turnId: 't', mode: 'auto' }),
      write: async () => ({
        file: { path: 'new.txt', kind: 'create' as const, add: 1, del: 0, hunks: [] },
        batchId: 'b1',
        unsaved: true as const,
      }),
    };
    const tool = getProjectTools({ editMode: 'auto' }).find((t) => t.spec.name === 'write_file');
    const result = await tool?.run({ path: 'new.txt', content: 'hello\n' }, { ...fx.ctx, changes });
    expect(result?.ok).toBe(true);
    expect(result?.output).toBe(`Created new.txt (1 line). Written to disk.\n${wording.autoUnsavedText()}`);
    expect(result?.output).not.toContain('Nothing was changed');
  });
});

describe('the write limit after CRLF line endings are kept', () => {
  it('edit_file on a CRLF file is still refused by the tool when the result is over the limit', async () => {
    const lines = 'x'.repeat(29);
    await write(fx.root, 'crlf.txt', `${lines}\r\n`.repeat(2));
    const big = `${lines}\n`.repeat(8600);
    const result = await run('edit_file', { path: 'crlf.txt', old_string: `${lines}\n${lines}\n`, new_string: big });
    expect(result.ok).toBe(false);
    expect(result.output).toBe(wording.editedTooLargeText('auto', big.length + 8600));
    expect(await readFile(path.join(fx.root, 'crlf.txt'), 'utf8')).toBe(`${lines}\r\n`.repeat(2));
  });
});
