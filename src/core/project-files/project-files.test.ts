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
  it('lists direct children only: honours .gitignore, skips node_modules, dirs first case-insensitively', async () => {
    await mkdir(path.join(dir, 'b'));
    await mkdir(path.join(dir, 'A'));
    await mkdir(path.join(dir, 'node_modules'));
    await mkdir(path.join(dir, 'dist'));
    await writeFile(path.join(dir, '.gitignore'), 'dist\n');
    for (const f of ['b/x.txt', 'A/y.txt', 'A/Z.txt', 'z.txt', 'Apple.txt', 'node_modules/q.js', 'dist/o.js'])
      await writeFile(path.join(dir, f), 'x');
    const root = await svc().list('p', '');
    expect(root).toEqual({
      path: '',
      truncated: false,
      entries: [
        { path: 'A', type: 'dir' },
        { path: 'b', type: 'dir' },
        { path: '.gitignore', type: 'file' },
        { path: 'Apple.txt', type: 'file' },
        { path: 'z.txt', type: 'file' },
      ],
    });
    expect(await svc().list('p', 'A')).toEqual({
      path: 'A',
      truncated: false,
      entries: [
        { path: 'A/y.txt', type: 'file' },
        { path: 'A/Z.txt', type: 'file' },
      ],
    });
  });

  it('applies the .gitignore files of the folder and its ancestors, and never shows symlinks', async () => {
    await mkdir(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    await writeFile(path.join(dir, '.gitignore'), '*.tmp\n');
    await writeFile(path.join(dir, 'a', '.gitignore'), 'skip-me/\n');
    await mkdir(path.join(dir, 'a', 'b', 'skip-me'));
    for (const f of ['a/b/keep.ts', 'a/b/x.tmp']) await writeFile(path.join(dir, f), 'x');
    await symlink(path.join(dir, 'a', 'b', 'keep.ts'), path.join(dir, 'a', 'b', 'link.ts'));
    await symlink(path.join(dir, 'a', 'b', 'c'), path.join(dir, 'a', 'b', 'linkdir'));
    expect((await svc().list('p', 'a/b')).entries.map((e) => e.path)).toEqual(['a/b/c', 'a/b/keep.ts']);
  });

  it(`truncates a folder at fileTreeFolderMaxEntries (${LIMITS.fileTreeFolderMaxEntries}), keeping the sorted first page`, async () => {
    await mkdir(path.join(dir, 'd'));
    const n = LIMITS.fileTreeFolderMaxEntries + 5;
    const name = (i: number) => `f${String(i).padStart(5, '0')}.txt`;
    await Promise.all(Array.from({ length: n }, (_, i) => writeFile(path.join(dir, 'd', name(i)), '')));
    await mkdir(path.join(dir, 'd', 'zz-dir'));
    const listing = await svc().list('p', 'd');
    expect(listing.truncated).toBe(true);
    expect(listing.entries.length).toBe(LIMITS.fileTreeFolderMaxEntries);
    expect(listing.entries[0]).toEqual({ path: 'd/zz-dir', type: 'dir' });
    expect(listing.entries[1]?.path).toBe(`d/${name(0)}`);
    expect(listing.entries.at(-1)?.path).toBe(`d/${name(LIMITS.fileTreeFolderMaxEntries - 2)}`);
    expect((await svc().list('p', '')).truncated).toBe(false);
  });

  it('honours the injected folder cap', async () => {
    for (const f of ['a.txt', 'b.txt', 'c.txt']) await writeFile(path.join(dir, f), '');
    const capped = createProjectFilesService({
      projects: { get: async () => ({ id: 'p', name: 'p', rootPath: dir, createdAt: '' }) },
      limits: { folderMaxEntries: 2 },
    });
    expect(await capped.list('p', '')).toEqual({
      path: '',
      truncated: true,
      entries: [
        { path: 'a.txt', type: 'file' },
        { path: 'b.txt', type: 'file' },
      ],
    });
  });

  it('lists only the direct children of a big folder, capped and marked truncated', async () => {
    await mkdir(path.join(dir, 'big', 'deep', 'deeper'), { recursive: true });
    await writeFile(path.join(dir, 'big', 'deep', 'deeper', 'buried.ts'), '');
    await Promise.all(Array.from({ length: 10_000 }, (_, i) => writeFile(path.join(dir, 'big', `f${i}.ts`), '')));
    const listing = await svc().list('p', 'big');
    expect(listing.truncated).toBe(true);
    expect(listing.entries.length).toBe(LIMITS.fileTreeFolderMaxEntries);
    expect(listing.entries[0]).toEqual({ path: 'big/deep', type: 'dir' });
    // Direct children only: nothing from inside `big/deep` is listed.
    expect(listing.entries.every((e) => e.path.split('/').length === 2)).toBe(true);
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
    const tree = await home.homeList('');
    expect(tree.root).toBe(await realpath(dir));
    expect(tree.path).toBe('');
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
    const svc = home();
    const at = async (d: string) => (await svc.homeList(d)).entries.map((e) => e.path);
    expect(await at('')).toEqual(['code', 'dotfiles', 'note.txt']);
    expect(await at('code')).toEqual(['code/app']);
    expect(await at('code/app')).toEqual(['code/app/README.md']);
    expect(await at('dotfiles')).toEqual(['dotfiles/ssh']);
    expect(await at('dotfiles/ssh')).toEqual([]);
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
    const paths = (await svc.homeList('dotfiles')).entries.map((e) => e.path);
    expect(paths).not.toContain('dotfiles/aws');
    await expect(svc.homeList('dotfiles/aws')).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await svc.homeSearch('credentials')).entries).toEqual([]);
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
      await expect(service('darwin').list('p', '')).rejects.toMatchObject({
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
      expect(await service('linux').list('p', '')).toEqual({ path: '', entries: [], truncated: false });
    } finally {
      await chmod(dir, 0o700);
    }
  });
  it.skipIf(process.getuid?.() === 0)('reports an unreadable non-root folder on darwin, empty on linux', async () => {
    const { chmod } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'sub', 'a.txt'), 'dummy');
    await chmod(path.join(dir, 'sub'), 0);
    try {
      await expect(service('darwin').list('p', 'sub')).rejects.toMatchObject({
        code: 'path_invalid',
        message: "You don't have permission to read this folder. Check its permissions in Finder (File › Get Info).",
      });
      expect(await service('linux').list('p', 'sub')).toEqual({ path: 'sub', entries: [], truncated: false });
      expect((await service('darwin').list('p', '')).entries.map((e) => e.path)).toEqual(['sub']);
    } finally {
      await chmod(path.join(dir, 'sub'), 0o700);
    }
  });
  it('A8-3a: lists an empty folder on both platforms', async () => {
    for (const platform of ['darwin', 'linux'] as const)
      expect(await service(platform).list('p', '')).toEqual({ path: '', entries: [], truncated: false });
  });
  it.skipIf(process.getuid?.() === 0)('A8-6g: reports unreadable files on darwin', async () => {
    const { chmod } = await import('node:fs/promises');
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'dummy');
    await chmod(file, 0);
    try {
      expect((await service('darwin').list('p', '')).entries.map((entry) => entry.path)).toContain('a.txt');
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

describe('client-supplied folders are checked like a full walk', () => {
  const put = async (rel: string, content = 'x\n') => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  };
  const outside = () => path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
  afterEach(async () => {
    await rm(outside(), { recursive: true, force: true });
  });
  /** A project folder holding one of each shape the panel must refuse, plus allowed controls. */
  async function project() {
    for (const f of [
      'src/a.ts',
      'src/deep/b.ts',
      'node_modules/pkg/index.js',
      'src/node_modules/x.js',
      'pkg/build/out.js',
      'gen/out.js',
      'src/gen/out.js',
      'keep/gen/out.js',
      '.git/config',
      'conf/.env.local/x',
      'certs.pem/x',
      'data/chats/index.json',
      'data/settings.json',
      'blocked/x.txt',
      'z.txt',
    ])
      await put(f);
    await writeFile(path.join(dir, '.gitignore'), 'gen/\n');
    await writeFile(path.join(dir, 'keep', '.gitignore'), '!gen/\n');
    await mkdir(outside(), { recursive: true });
    await writeFile(path.join(outside(), 'secret.txt'), 'outside\n');
    await symlink(path.join(dir, 'src'), path.join(dir, 'srclink'));
    await symlink(outside(), path.join(dir, 'outlink'));
  }
  const service = () =>
    createProjectFilesService({
      projects: { get: async () => ({ id: 'p', name: 'p', rootPath: dir, createdAt: '' }) },
      deniedRoots: [path.join(dir, 'blocked')],
    });

  it('lists allowed folders', async () => {
    await project();
    const svc = service();
    expect((await svc.list('p', '')).entries.map((e) => e.path)).toEqual([
      'conf',
      'keep',
      'pkg',
      'src',
      '.gitignore',
      'z.txt',
    ]);
    expect((await svc.list('p', 'src')).entries.map((e) => e.path)).toEqual(['src/deep', 'src/a.ts']);
    expect((await svc.list('p', 'src/deep')).entries.map((e) => e.path)).toEqual(['src/deep/b.ts']);
    expect((await svc.list('p', 'conf')).entries).toEqual([]);
    // A deeper `.gitignore` re-includes `gen/`, so the full walk enters it, and so does the panel.
    expect((await svc.list('p', 'keep')).entries.map((e) => e.path)).toEqual(['keep/gen', 'keep/.gitignore']);
    await expect(svc.list('p', 'keep/gen')).resolves.toMatchObject({ path: 'keep/gen', truncated: false });
  });

  it.each([
    ['../x', 'escapes the root'],
    ['..', 'escapes the root'],
    ['src/../..', 'escapes the root'],
    ['/etc', 'absolute, outside'],
    ['outlink', 'symlink leaving the root'],
    ['outlink/', 'symlink leaving the root'],
    ['.git', 'denied entry name (and always skipped)'],
    ['conf/.env.local', 'denied entry name'],
    ['certs.pem', 'denied entry name'],
    ['data', "the app's data dir"],
    ['data/chats', "inside the app's data dir"],
    ['blocked', 'a denied root'],
    ['src/a\0b', 'NUL byte'],
    ['src/./deep', 'non-canonical spelling'],
    ['src/deep/', 'non-canonical spelling'],
    ['src//deep', 'non-canonical spelling'],
    ['src/deep/../deep', 'non-canonical spelling'],
    ['z.txt', 'a file'],
    ['src/a.ts', 'a file'],
  ])('refuses %j (%s) with invalid_request', async (bad) => {
    await project();
    await expect(service().list('p', bad)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('refuses an absolute path even when it points inside the root', async () => {
    await project();
    await expect(service().list('p', path.join(await realpath(dir), 'src'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it.each([
    ['node_modules', 'always skipped'],
    ['node_modules/pkg', 'below an always-skipped dir'],
    ['src/node_modules', 'always skipped at depth'],
    ['pkg/build', 'always skipped at depth'],
    ['gen', 'gitignored'],
    ['src/gen', 'gitignored by an ancestor .gitignore'],
    ['srclink', 'symlink to a folder inside the root'],
    ['srclink/deep', 'through a symlinked segment'],
    ['nope', 'missing'],
    ['src/nope', 'missing'],
    ['SRC', 'another spelling of an allowed folder'],
    ['Node_Modules', 'another spelling of an always-skipped dir'],
  ])('refuses %j (%s) with not_found', async (bad) => {
    await project();
    await expect(service().list('p', bad)).rejects.toMatchObject({ code: 'not_found' });
  });

  describe('home', () => {
    const home = () =>
      createProjectFilesService({
        projects: {
          get: async () => {
            throw new Error('unused');
          },
        },
        homeDir: dir,
      });
    async function homeFolder() {
      for (const f of [
        'code/app/README.md',
        'code/app/node_modules/x.js',
        'code/.aws/credentials',
        '.ssh/config',
        '.config/x',
        'Library/Keychains/k',
        'dotfiles/aws/credentials',
        'note.txt',
      ])
        await put(f);
      await symlink(path.join(dir, 'dotfiles', 'aws'), path.join(dir, '.aws'));
      await symlink(path.join(dir, 'code'), path.join(dir, 'codelink'));
    }

    it('lists allowed folders', async () => {
      await homeFolder();
      expect((await home().homeList('code')).entries.map((e) => e.path)).toEqual(['code/app']);
      expect((await home().homeList('code/app')).entries.map((e) => e.path)).toEqual(['code/app/README.md']);
    });

    it.each([
      ['..', 'escapes home'],
      ['../x', 'escapes home'],
      ['/etc', 'absolute'],
      ['.ssh', 'top-level dotfile'],
      ['.config', 'top-level dotfile'],
      ['Library', 'app-data folder'],
      ['Library/Keychains', 'inside an app-data folder'],
      ['code/.aws', 'credential folder at depth'],
      ['.aws', 'symlinked credential folder'],
      ['dotfiles/aws', 'target of a symlinked credential folder'],
      ['note.txt', 'a file'],
    ])('refuses %j (%s) with invalid_request', async (bad) => {
      await homeFolder();
      await expect(home().homeList(bad)).rejects.toMatchObject({ code: 'invalid_request' });
    });

    it.each([
      ['code/app/node_modules', 'always skipped'],
      ['codelink', 'symlinked folder'],
      ['codelink/app', 'through a symlinked segment'],
      ['nope', 'missing'],
    ])('refuses %j (%s) with not_found', async (bad) => {
      await homeFolder();
      await expect(home().homeList(bad)).rejects.toMatchObject({ code: 'not_found' });
    });
  });
});

describe('search', () => {
  const put = async (rel: string, content = 'x\n') => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  };
  const service = (limits?: Parameters<typeof createProjectFilesService>[0]['limits']) =>
    createProjectFilesService({
      projects: { get: async () => ({ id: 'p', name: 'p', rootPath: dir, createdAt: '' }) },
      limits,
    });

  it('matches files by path, case-insensitively, shallow first, obeying the same rules as listing', async () => {
    for (const f of [
      'README.md',
      'src/Read-File.ts',
      'src/tools/read-file.test.ts',
      'readers/a.txt',
      'node_modules/read-file/index.js',
      'gen/read-file.js',
      '.env.read',
      'secrets.json',
    ])
      await put(f);
    await writeFile(path.join(dir, '.gitignore'), 'gen/\n');
    await symlink(path.join(dir, 'README.md'), path.join(dir, 'read-link.md'));
    const res = await service().search('p', '  READ ');
    expect(res).toEqual({
      truncated: false,
      entries: [
        { path: 'README.md', type: 'file' },
        { path: 'readers/a.txt', type: 'file' },
        { path: 'src/Read-File.ts', type: 'file' },
        { path: 'src/tools/read-file.test.ts', type: 'file' },
      ],
    });
    expect((await service().search('p', 'src/tools')).entries.map((e) => e.path)).toEqual([
      'src/tools/read-file.test.ts',
    ]);
    // Folders alone never match: only files are results.
    expect((await service().search('p', 'readers')).entries.map((e) => e.path)).toEqual(['readers/a.txt']);
  });

  it.each(['', '   ', '\t\n'])('refuses the empty query %j', async (q) => {
    await expect(service().search('p', q)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('refuses an overlong query', async () => {
    await expect(service().search('p', 'x'.repeat(LIMITS.fileSearchMaxQueryLength + 1))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it(`stops at fileSearchMaxResults (${LIMITS.fileSearchMaxResults}) matches`, async () => {
    await mkdir(path.join(dir, 'm'));
    const n = LIMITS.fileSearchMaxResults + 3;
    await Promise.all(Array.from({ length: n }, (_, i) => writeFile(path.join(dir, 'm', `hit${i}.txt`), '')));
    const res = await service().search('p', 'hit');
    expect(res.truncated).toBe('results');
    expect(res.entries.length).toBe(LIMITS.fileSearchMaxResults);
    // Exactly the cap is not truncated.
    const exact = await service({ searchMaxResults: n }).search('p', 'hit');
    expect(exact).toMatchObject({ truncated: false });
    expect(exact.entries.length).toBe(n);
  });

  it('stops after scanning searchMaxScanned entries', async () => {
    for (const f of ['a/1.txt', 'a/2.txt', 'b/hit.txt']) await put(f);
    // Walk order: a, b, a/1.txt, a/2.txt, b/hit.txt.
    expect(await service({ searchMaxScanned: 4 }).search('p', 'txt')).toEqual({
      truncated: 'scanned',
      entries: [
        { path: 'a/1.txt', type: 'file' },
        { path: 'a/2.txt', type: 'file' },
      ],
    });
    expect((await service({ searchMaxScanned: 5 }).search('p', 'hit')).truncated).toBe(false);
    // Zero matches in the part that was walked is still a scan-cap stop, not a complete "no matches".
    expect(await service({ searchMaxScanned: 4 }).search('p', 'hit')).toEqual({ truncated: 'scanned', entries: [] });
    // The scan cap wins over a result cap that was never reached.
    expect((await service({ searchMaxScanned: 4, searchMaxResults: 5 }).search('p', 'txt')).truncated).toBe('scanned');
  });

  it('honours an aborted signal', async () => {
    await put('a/hit.txt');
    const c = new AbortController();
    c.abort();
    expect(await service().search('p', 'hit', c.signal)).toEqual({ entries: [], truncated: 'scanned' });
  });

  it('applies the home deny layer', async () => {
    for (const f of ['.ssh/hit', 'Library/hit.txt', 'code/.aws/hit', 'code/hit.txt']) await put(f);
    const home = createProjectFilesService({
      projects: {
        get: async () => {
          throw new Error('unused');
        },
      },
      homeDir: dir,
    });
    expect((await home.homeSearch('hit')).entries.map((e) => e.path)).toEqual(['code/hit.txt']);
  });
});
