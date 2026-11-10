import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ERROR_STATUS } from '@shared/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreError, toErrorInfo } from '../errors';
import { createProjectFilesService } from './index';

const rules = vi.hoisted(() => [] as { op: string; path: string; code: string }[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrap =
    (op: 'readdir' | 'realpath' | 'open' | 'readFile') =>
    (...args: unknown[]) => {
      const rule = rules.find((r) => r.op === op && r.path === String(args[0]));
      if (rule)
        throw Object.assign(new Error(`${rule.code}: injected`), { code: rule.code, syscall: op, path: rule.path });
      return (actual[op] as (...args: never[]) => unknown)(...(args as never[]));
    };
  return {
    ...actual,
    readdir: wrap('readdir'),
    realpath: wrap('realpath'),
    open: wrap('open'),
    readFile: wrap('readFile'),
  };
});
const folderPrivacy =
  'macOS blocked access to this folder. Allow access in System Settings › Privacy & Security › Files & Folders.';
const folderPermission =
  "You don't have permission to read this folder. Check its permissions in Finder (File › Get Info).";
const filePrivacy =
  'macOS blocked access to this file. Allow access in System Settings › Privacy & Security › Files & Folders.';
const filePermission =
  "You don't have permission to read this file. Check its permissions in Finder (File › Get Info).";
let dir: string;
beforeEach(async () => {
  rules.length = 0;
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'as08-')));
});
afterEach(async () => {
  rules.length = 0;
  await rm(dir, { recursive: true, force: true });
});
const service = (platform: NodeJS.Platform, extra = {}) =>
  createProjectFilesService({
    projects: { get: async () => ({ id: 'p', name: 'p', rootPath: dir, createdAt: '' }) },
    platform,
    ...extra,
  } as Parameters<typeof createProjectFilesService>[0]);
const deny = (op: string, target: string, code: string) => rules.push({ op, path: target, code });
const empty = { entries: [], truncated: false };
const match = (message: string) => ({ code: 'path_invalid', message });

describe('AS-08 injected denials', () => {
  it('A8-1a root EPERM maps to privacy and HTTP error', async () => {
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'README.md'), 'dummy');
    await writeFile(path.join(dir, 'sub/note.txt'), 'dummy');
    deny('readdir', dir, 'EPERM');
    const err = await service('darwin')
      .tree('p')
      .catch((e: unknown) => e);
    expect(err).toMatchObject(match(folderPrivacy));
    expect(toErrorInfo(err)).toEqual({ code: 'path_invalid', message: folderPrivacy, retryable: false });
    expect(ERROR_STATUS.path_invalid).toBe(400);
  });
  it('A8-1b root realpath EPERM', async () => {
    deny('realpath', dir, 'EPERM');
    await expect(service('darwin').tree('p')).rejects.toMatchObject(match(folderPrivacy));
  });
  it('A8-1c root EACCES', async () => {
    deny('readdir', dir, 'EACCES');
    await expect(service('darwin').tree('p')).rejects.toMatchObject(match(folderPermission));
  });
  it('A8-1d home root EPERM', async () => {
    deny('readdir', dir, 'EPERM');
    await expect(service('darwin', { homeDir: dir }).homeTree()).rejects.toMatchObject(match(folderPrivacy));
  });
  for (const [id, platform, code] of [
    ['4a', 'linux', 'EPERM'],
    ['4b', 'linux', 'EACCES'],
    ['4d', 'win32', 'EPERM'],
    ['4e', 'darwin', 'ENOENT'],
  ] as const)
    it(`A8-${id} preserves empty tree`, async () => {
      deny('readdir', dir, code);
      expect(await service(platform).tree('p')).toEqual(empty);
    });
  it('A8-4c linux realpath remains generic', async () => {
    deny('realpath', dir, 'EPERM');
    await expect(service('linux').tree('p')).rejects.toMatchObject(
      match('That folder does not exist or cannot be read.'),
    );
  });
  it('A8-4f aborted tree stays empty', async () => {
    deny('readdir', dir, 'EPERM');
    const c = new AbortController();
    c.abort();
    expect(await service('darwin').tree('p', c.signal)).toEqual(empty);
  });
  it('A8-3b hidden entries stay empty', async () => {
    await mkdir(path.join(dir, 'node_modules'));
    await writeFile(path.join(dir, 'node_modules/x.js'), 'x');
    await writeFile(path.join(dir, '.env'), 'x');
    expect(await service('darwin').tree('p')).toEqual(empty);
  });
  it('A8-8a denied root remains empty', async () => {
    deny('readdir', dir, 'EPERM');
    expect(await service('darwin', { deniedRoots: [dir] }).tree('p')).toEqual(empty);
  });
  it('A8-8b denied subfolder remains silent', async () => {
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'sub/note.txt'), 'x');
    await writeFile(path.join(dir, 'README.md'), 'x');
    deny('readdir', path.join(dir, 'sub'), 'EPERM');
    expect((await service('darwin').tree('p')).entries.map((e) => e.path)).toEqual(['sub', 'README.md']);
  });
  it('A8-6a viewer EPERM maps without content or path', async () => {
    await writeFile(path.join(dir, 'README.md'), 'NEEDLE');
    deny('open', path.join(dir, 'README.md'), 'EPERM');
    const err = await service('darwin')
      .read('p', 'README.md')
      .catch((e: unknown) => e);
    expect(err).toMatchObject(match(filePrivacy));
    expect((err as Error).message).not.toContain('NEEDLE');
    expect((err as Error).message).not.toContain(dir);
    expect(toErrorInfo(err).code).not.toBe('internal');
  });
  it('A8-6b viewer EACCES', async () => {
    await writeFile(path.join(dir, 'README.md'), 'x');
    deny('open', path.join(dir, 'README.md'), 'EACCES');
    await expect(service('darwin').read('p', 'README.md')).rejects.toMatchObject(match(filePermission));
  });
  it('A8-6c attachment EPERM', async () => {
    await writeFile(path.join(dir, 'img.png'), 'x');
    deny('readFile', path.join(dir, 'img.png'), 'EPERM');
    await expect(service('darwin').readBytes('p', 'img.png')).rejects.toMatchObject(match(filePrivacy));
  });
  it('A8-6d home viewer EPERM', async () => {
    await writeFile(path.join(dir, 'note.txt'), 'x');
    deny('open', path.join(dir, 'note.txt'), 'EPERM');
    await expect(service('darwin', { homeDir: dir }).homeRead('note.txt')).rejects.toMatchObject(match(filePrivacy));
  });
  for (const [id, platform, code] of [
    ['6e', 'linux', 'EPERM'],
    ['6f', 'darwin', 'ENOENT'],
  ] as const)
    it(`A8-${id} preserves raw error`, async () => {
      await writeFile(path.join(dir, 'README.md'), 'x');
      deny('open', path.join(dir, 'README.md'), code);
      const err = await service(platform)
        .read('p', 'README.md')
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code });
      expect(err).not.toBeInstanceOf(CoreError);
      expect(toErrorInfo(err).code).toBe('internal');
    });
});
