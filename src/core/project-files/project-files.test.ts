import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

describe('home deny layer', () => {
  const home = () =>
    createProjectFilesService({
      projects: {
        get: async () => {
          throw new Error('unused');
        },
      },
      homeDir: dir,
    });
  const put = async (rel: string, content = 'x\n') => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  };
  const denied = [
    '.ssh/config',
    '.ssh/id_ecdsa',
    '.aws/credentials',
    '.netrc',
    '.git-credentials',
    '.npmrc',
    '.config/gh/hosts.yml',
    '.mozilla/x',
    'snap/firefox/common/x',
    'Library/Keychains/k',
    'code/app/.npmrc',
    'dotfiles/ssh/.ssh/config',
  ];

  beforeEach(async () => {
    for (const f of [...denied, 'note.txt', 'code/app/README.md']) await put(f);
  });

  it('hides dotfiles, app-data folders and credential folders at any depth', async () => {
    const { entries } = await home().homeTree();
    expect(entries.map((e) => e.path)).toEqual([
      'code',
      'code/app',
      'code/app/README.md',
      'dotfiles',
      'dotfiles/ssh',
      'note.txt',
    ]);
  });

  it('refuses to read every denied path, whatever the spelling', async () => {
    const svc = home();
    for (const p of [
      ...denied,
      '.SSH/config',
      'code/../.ssh/config',
      'LIBRARY/Keychains/k',
      'dotfiles/ssh/.SSH/config',
    ]) {
      await expect(svc.homeRead(p), p).rejects.toBeInstanceOf(CoreError);
      await expect(svc.homeReadBytes(p), p).rejects.toBeInstanceOf(CoreError);
    }
    expect((await svc.homeRead('code/app/README.md')).content).toBe('x\n');
  });

  it('hides the target of a symlinked denied entry', async () => {
    await rm(path.join(dir, '.aws'), { recursive: true });
    await put('dotfiles/aws/credentials', 'aws_secret_access_key=1\n');
    await symlink(path.join(dir, 'dotfiles', 'aws'), path.join(dir, '.aws'));
    const svc = home();
    const paths = (await svc.homeTree()).entries.map((e) => e.path);
    expect(paths).not.toContain('dotfiles/aws');
    expect(paths).not.toContain('dotfiles/aws/credentials');
    await expect(svc.homeRead('dotfiles/aws/credentials')).rejects.toBeInstanceOf(CoreError);
    await expect(svc.homeRead('.aws/credentials')).rejects.toBeInstanceOf(CoreError);
  });

  it('rejects hardlinked files', async () => {
    await link(path.join(dir, '.aws', 'credentials'), path.join(dir, 'creds-copy'));
    const svc = home();
    await expect(svc.homeRead('creds-copy')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(svc.homeReadBytes('creds-copy')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('does not apply to projects', async () => {
    expect((await svc().read('p', '.npmrc')).content).toBe('x\n');
    expect((await svc().read('p', 'code/app/.npmrc')).content).toBe('x\n');
  });
});

describe('access denials on a real filesystem (AS-08)', () => {
  const service = (platform: NodeJS.Platform) =>
    createProjectFilesService({
      projects: { get: async () => ({ id: 'p', name: 'p', rootPath: dir, createdAt: '' }) },
      platform,
    } as Parameters<typeof createProjectFilesService>[0]);
  // root bypasses mode bits, so chmod 000 can't produce EACCES.
  it.skipIf(process.getuid?.() === 0)('A8-2a: reports an unreadable root on darwin', async () => {
    const { chmod } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'a.txt'), 'dummy');
    await chmod(dir, 0);
    try {
      await expect(service('darwin').tree('p')).rejects.toMatchObject({
        code: 'path_invalid',
        message: "You don't have permission to read this folder. Check its permissions in Finder (File › Get Info).",
      });
    } finally {
      await chmod(dir, 0o700);
    }
  });
  it.skipIf(process.getuid?.() === 0)('A8-2b: preserves empty tree for unreadable root on linux', async () => {
    const { chmod } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'a.txt'), 'dummy');
    await chmod(dir, 0);
    try {
      expect(await service('linux').tree('p')).toEqual({ entries: [], truncated: false });
    } finally {
      await chmod(dir, 0o700);
    }
  });
  it('A8-3a: lists an empty folder on both platforms', async () => {
    for (const platform of ['darwin', 'linux'] as const)
      expect(await service(platform).tree('p')).toEqual({ entries: [], truncated: false });
  });
  it.skipIf(process.getuid?.() === 0)('A8-6g: reports unreadable files on darwin', async () => {
    const { chmod } = await import('node:fs/promises');
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'dummy');
    await chmod(file, 0);
    try {
      expect((await service('darwin').tree('p')).entries.map((entry) => entry.path)).toContain('a.txt');
      await expect(service('darwin').read('p', 'a.txt')).rejects.toMatchObject({
        code: 'path_invalid',
        message: "You don't have permission to read this file. Check its permissions in Finder (File › Get Info).",
      });
    } finally {
      await chmod(file, 0o600);
    }
  });
  it.skipIf(process.getuid?.() === 0)('A8-6h: preserves raw unreadable file error on linux', async () => {
    const { chmod } = await import('node:fs/promises');
    const { toErrorInfo } = await import('../errors');
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'dummy');
    await chmod(file, 0);
    try {
      const err = await service('linux')
        .read('p', 'a.txt')
        .catch((error: unknown) => error);
      expect(err).toMatchObject({ code: 'EACCES' });
      expect(toErrorInfo(err).code).toBe('internal');
    } finally {
      await chmod(file, 0o600);
    }
  });
});
