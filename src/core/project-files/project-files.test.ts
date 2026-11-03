import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreError } from '../errors';
import { createProjectFilesService } from './index';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'openvern-pf-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const svc = () =>
  createProjectFilesService({ projects: { get: async () => ({ id: 'p', name: 'p', rootPath: dir, createdAt: '' }) } });

describe('ProjectFilesService', () => {
  it('honours .gitignore, skips node_modules and orders dirs first case-insensitively', async () => {
    await mkdir(path.join(dir, 'b'));
    await mkdir(path.join(dir, 'A'));
    await mkdir(path.join(dir, 'node_modules'));
    await mkdir(path.join(dir, 'dist'));
    await writeFile(path.join(dir, '.gitignore'), 'dist\n');
    for (const f of ['b/x.txt', 'A/y.txt', 'z.txt', 'Apple.txt', 'node_modules/q.js', 'dist/o.js'])
      await writeFile(path.join(dir, f), 'x');
    const { entries } = await svc().tree('p');
    expect(entries.map((e) => e.path)).toEqual(['A', 'A/y.txt', 'b', 'b/x.txt', '.gitignore', 'Apple.txt', 'z.txt']);
  });

  it('truncates at fileTreeMaxEntries', async () => {
    await mkdir(path.join(dir, 'd'));
    const n = LIMITS.fileTreeMaxEntries + 5;
    await Promise.all(Array.from({ length: n }, (_, i) => writeFile(path.join(dir, 'd', `f${i}.txt`), '')));
    const tree = await svc().tree('p');
    expect(tree.truncated).toBe(true);
    expect(tree.entries.length).toBe(LIMITS.fileTreeMaxEntries);
  });

  it('lists ~10k files in under 2 s', async () => {
    for (let d = 0; d < 100; d++) {
      await mkdir(path.join(dir, `dir${d}`));
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(path.join(dir, `dir${d}`, `f${i}.ts`), '')));
    }
    const t = Date.now();
    const tree = await svc().tree('p');
    expect(Date.now() - t).toBeLessThan(2000);
    expect(tree.entries.length).toBe(10_100);
  });

  it('cuts big files at viewerMaxBytes on a character boundary', async () => {
    await writeFile(path.join(dir, 'big.txt'), `${'é'.repeat(LIMITS.viewerMaxBytes / 2 + 10)}\n`);
    const r = await svc().read('p', 'big.txt');
    expect(r.truncated).toBe(true);
    expect(r.content).not.toContain('�');
    expect(r.size).toBeGreaterThan(LIMITS.viewerMaxBytes);
  });

  it('lists the home directory and refuses to leave it', async () => {
    await writeFile(path.join(dir, 'note.txt'), 'hi\n');
    await writeFile(path.join(dir, '.env'), 'SECRET=1\n');
    const home = createProjectFilesService({
      projects: {
        get: async () => {
          throw new Error('unused');
        },
      },
      homeDir: dir,
    });
    const tree = await home.homeTree();
    expect(tree.root).toBe(await realpath(dir));
    expect(tree.entries.map((e) => e.path)).toEqual(['note.txt']);
    expect((await home.homeRead('note.txt')).content).toBe('hi\n');
    await expect(home.homeRead('.env')).rejects.toBeInstanceOf(CoreError);
    await expect(home.homeRead('../note.txt')).rejects.toBeInstanceOf(CoreError);
  });

  it('counts lines and rejects directories and denied files', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'a\nb\nc');
    await writeFile(path.join(dir, 'secrets.json'), '{}');
    expect((await svc().read('p', 'a.txt')).totalLines).toBe(3);
    await expect(svc().read('p', 'secrets.json')).rejects.toBeInstanceOf(CoreError);
    await expect(svc().read('p', '')).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
