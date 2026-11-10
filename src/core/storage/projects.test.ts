import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectsService } from './projects';
import { cleanupTempDirs, makeStorage, makeTempDir } from './test-helpers';

cleanupTempDirs();

async function makeDir(name: string): Promise<string> {
  const dir = path.join(await makeTempDir(), name);
  await fs.mkdir(dir);
  return await fs.realpath(dir);
}

describe('ProjectsService', () => {
  it('creates a project named after the folder, with a realpath rootPath', async () => {
    const { storage } = await makeStorage();
    const dir = await makeDir('my-app');
    const link = path.join(path.dirname(dir), 'link');
    await fs.symlink(dir, link);
    const project = await storage.projects.create({ rootPath: link });
    expect(project.rootPath).toBe(dir);
    expect(project.name).toBe('my-app');
    expect(await storage.projects.get(project.id)).toEqual(project);
  });

  it('uses an explicit (trimmed) name', async () => {
    const { storage } = await makeStorage();
    const project = await storage.projects.create({ rootPath: await makeDir('x'), name: '  Nice name ' });
    expect(project.name).toBe('Nice name');
  });

  it('expands ~ (against $HOME)', async () => {
    const { storage } = await makeStorage();
    const home = await makeTempDir('openvern-home-');
    await fs.mkdir(path.join(home, 'code'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(os.homedir()).toBe(home);
      const project = await storage.projects.create({ rootPath: '~/code' });
      expect(project.rootPath).toBe(await fs.realpath(path.join(home, 'code')));
      expect(project.name).toBe('code');
      await expect(storage.projects.create({ rootPath: '~' })).resolves.toMatchObject({
        rootPath: await fs.realpath(home),
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it('rejects missing paths and files with path_invalid', async () => {
    const { storage } = await makeStorage();
    const dir = await makeDir('d');
    await expect(storage.projects.create({ rootPath: path.join(dir, 'nope') })).rejects.toMatchObject({
      code: 'path_invalid',
    });
    const file = path.join(dir, 'f.txt');
    await fs.writeFile(file, 'x');
    await expect(storage.projects.create({ rootPath: file })).rejects.toMatchObject({ code: 'path_invalid' });
    await expect(storage.projects.create({ rootPath: '   ' })).rejects.toMatchObject({ code: 'path_invalid' });
  });

  it('rejects the data dir and folders inside it, also via symlink, but allows a folder containing it (S1-M1)', async () => {
    const { storage, dataDir } = await makeStorage();
    const realData = await fs.realpath(dataDir);
    const link = path.join(path.dirname(realData), 'chats-link');
    await fs.symlink(path.join(realData, 'chats'), link);
    for (const rootPath of [dataDir, path.join(dataDir, 'chats'), link]) {
      await expect(storage.projects.create({ rootPath }), rootPath).rejects.toMatchObject({ code: 'path_invalid' });
    }
    await expect(storage.projects.create({ rootPath: path.dirname(dataDir) })).resolves.toMatchObject({
      rootPath: path.dirname(realData),
    });
  });

  it('rejects relative paths instead of resolving them against the cwd (S1-N1)', async () => {
    const { storage } = await makeStorage();
    const cwd = await makeDir('cwd');
    await fs.mkdir(path.join(cwd, 'src'));
    const prev = process.cwd();
    process.chdir(cwd);
    try {
      for (const rootPath of ['.', 'src', './src', '..']) {
        await expect(storage.projects.create({ rootPath }), rootPath).rejects.toMatchObject({
          code: 'path_invalid',
          message: 'Enter an absolute path to a folder.',
        });
      }
    } finally {
      process.chdir(prev);
    }
    expect(await storage.projects.list()).toEqual([]);
  });

  it('rejects an unreadable directory with path_invalid', async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const { storage } = await makeStorage();
    const dir = await makeDir('locked');
    await fs.chmod(dir, 0o000);
    try {
      await expect(storage.projects.create({ rootPath: dir })).rejects.toMatchObject({ code: 'path_invalid' });
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });

  it('rejects the same realpath twice (also via symlink / trailing slash) with conflict', async () => {
    const { storage } = await makeStorage();
    const dir = await makeDir('dup');
    const link = path.join(path.dirname(dir), 'dup-link');
    await fs.symlink(dir, link);
    await storage.projects.create({ rootPath: dir });
    await expect(storage.projects.create({ rootPath: link })).rejects.toMatchObject({ code: 'conflict' });
    await expect(storage.projects.create({ rootPath: `${dir}/` })).rejects.toMatchObject({ code: 'conflict' });
    expect(await storage.projects.list()).toHaveLength(1);
  });

  it('only one of two concurrent creates for the same folder wins', async () => {
    const { storage } = await makeStorage();
    const dir = await makeDir('race');
    const results = await Promise.allSettled([
      storage.projects.create({ rootPath: dir }),
      storage.projects.create({ rootPath: dir }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await storage.projects.list()).toHaveLength(1);
  });

  it('lists sorted by name case-insensitively with chatCount', async () => {
    const { storage } = await makeStorage();
    const b = await storage.projects.create({ rootPath: await makeDir('b'), name: 'beta' });
    const a = await storage.projects.create({ rootPath: await makeDir('a'), name: 'Alpha' });
    const c = await storage.projects.create({ rootPath: await makeDir('c'), name: 'Charlie' });
    await storage.chats.create({ projectId: b.id, model: 'm' });
    await storage.chats.create({ projectId: b.id, model: 'm' });
    await storage.chats.create({ projectId: null, model: 'm' });
    const list = await storage.projects.list();
    expect(list.map((p) => [p.name, p.chatCount])).toEqual([
      ['Alpha', 0],
      ['beta', 2],
      ['Charlie', 0],
    ]);
    expect([a.id, b.id, c.id]).toContain(list[0]?.id);
  });

  it('renames; unknown ids give not_found', async () => {
    const { storage } = await makeStorage();
    const p = await storage.projects.create({ rootPath: await makeDir('r') });
    expect((await storage.projects.rename(p.id, ' New ')).name).toBe('New');
    expect((await storage.projects.get(p.id)).name).toBe('New');
    await expect(storage.projects.rename('nope', 'x')).rejects.toMatchObject({ code: 'not_found' });
    await expect(storage.projects.get('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(storage.projects.remove('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('remove re-homes its chats to projectId null and never touches the folder', async () => {
    const { storage } = await makeStorage();
    const dir = await makeDir('keep-me');
    await fs.writeFile(path.join(dir, 'file.txt'), 'hello');
    const p = await storage.projects.create({ rootPath: dir });
    const other = await storage.projects.create({ rootPath: await makeDir('other') });
    const c1 = await storage.chats.create({ projectId: p.id, model: 'm' });
    const c2 = await storage.chats.create({ projectId: p.id, model: 'm' });
    const c3 = await storage.chats.create({ projectId: other.id, model: 'm' });
    const before = (await storage.chats.get(c1.id)).updatedAt;

    await storage.projects.remove(p.id);

    expect(await storage.projects.list()).toHaveLength(1);
    expect((await storage.chats.get(c1.id)).projectId).toBeNull();
    expect((await storage.chats.get(c2.id)).projectId).toBeNull();
    expect((await storage.chats.get(c3.id)).projectId).toBe(other.id);
    expect((await storage.chats.get(c1.id)).updatedAt).toBe(before);
    const index = await storage.chats.list();
    expect(
      index
        .filter((c) => c.projectId === null)
        .map((c) => c.id)
        .sort(),
    ).toEqual([c1.id, c2.id].sort());
    expect(await fs.readFile(path.join(dir, 'file.txt'), 'utf8')).toBe('hello');
  });
});

describe('macOS access denials (AS-08)', () => {
  afterEach(() => vi.restoreAllMocks());
  const privacy =
    'macOS blocked access to this folder. Allow access in System Settings › Privacy & Security › Files & Folders.';
  const permission =
    "You don't have permission to read this folder. Check its permissions in Finder (File › Get Info).";
  const generic = 'That folder does not exist or cannot be read.';
  async function setup(platform: NodeJS.Platform) {
    const base = await fs.realpath(await makeTempDir());
    const dir = path.join(base, 'project');
    const dataDir = path.join(base, 'data');
    await fs.mkdir(dir);
    await fs.mkdir(dataDir);
    const opts = {
      filePath: path.join(dataDir, 'projects.json'),
      dataDir,
      platform,
      chats: { list: async () => [], detachProject: async () => {} },
    };
    return { dir, dataDir, service: createProjectsService(opts) };
  }
  for (const [id, op, code, message] of [
    ['5a', 'access', 'EPERM', privacy],
    ['5b', 'realpath', 'EPERM', privacy],
    ['5c', 'access', 'EACCES', permission],
    ['5e', 'access', 'EPERM', generic],
  ] as const) {
    it(`A8-${id} maps injected ${op} ${code}`, async () => {
      const { dir, service } = await setup(id === '5e' ? 'linux' : 'darwin');
      const original = fs[op].bind(fs);
      vi.spyOn(fs, op).mockImplementation(((p: unknown, ...args: unknown[]) => {
        if (p === dir)
          return Promise.reject(Object.assign(new Error(`${code}: injected`), { code, syscall: op, path: dir }));
        return (original as (...a: never[]) => unknown)(...([p, ...args] as never[]));
      }) as never);
      await expect(service.create({ rootPath: dir })).rejects.toMatchObject({ code: 'path_invalid', message });
      expect(await service.list()).toEqual([]);
    });
  }
  // root bypasses mode bits, so chmod 000 can't produce EACCES.
  for (const [id, platform, message] of [
    ['5d', 'darwin', permission],
    ['5f', 'linux', generic],
  ] as const)
    it.skipIf(process.getuid?.() === 0)(`A8-${id} real mode denial`, async () => {
      const { dir, service } = await setup(platform);
      await fs.chmod(dir, 0);
      try {
        await expect(service.create({ rootPath: dir })).rejects.toMatchObject({ code: 'path_invalid', message });
      } finally {
        await fs.chmod(dir, 0o700);
      }
    });
  it('A8-5g preserves validation messages', async () => {
    const { dir, dataDir, service } = await setup('darwin');
    const file = path.join(dir, 'file');
    await fs.writeFile(file, 'x');
    for (const rootPath of [path.join(dir, 'missing'), file, '   '])
      await expect(service.create({ rootPath })).rejects.toMatchObject({ code: 'path_invalid', message: generic });
    await expect(service.create({ rootPath: 'src' })).rejects.toMatchObject({
      code: 'path_invalid',
      message: 'Enter an absolute path to a folder.',
    });
    await expect(service.create({ rootPath: dataDir })).rejects.toMatchObject({
      code: 'path_invalid',
      message: 'This folder is inside the app data folder and cannot be a project.',
    });
  });
  it('A8-5h accepts a symlink to a readable directory', async () => {
    const { dir, service } = await setup('darwin');
    const link = `${dir}-link`;
    await fs.symlink(dir, link);
    expect((await service.create({ rootPath: link })).rootPath).toBe(dir);
  });
});
