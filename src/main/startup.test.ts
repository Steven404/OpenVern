import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveDataDir as backendResolve } from '../core/storage/paths';
import { noSandboxWarning, resolveUserDataDir } from './startup';

const appDataDir = '/home/u/.config';
const base = { isPackaged: false, isDev: false, hasUserDataDirSwitch: false, appDataDir };

describe('resolveUserDataDir (S8-N3)', () => {
  it('keeps the default profile when packaged', () => {
    expect(resolveUserDataDir({ ...base, isPackaged: true })).toBeNull();
    expect(resolveUserDataDir({ ...base, isPackaged: true, hasUserDataDirSwitch: true })).toBeNull();
  });

  it('uses harness-dev for unpackaged dev', () => {
    expect(resolveUserDataDir({ ...base, isDev: true })).toBe(path.join(appDataDir, 'harness-dev'));
  });

  it('uses harness-preview for unpackaged non-dev (preview / bare electron .)', () => {
    expect(resolveUserDataDir(base)).toBe(path.join(appDataDir, 'harness-preview'));
  });

  it('leaves an explicit --user-data-dir alone', () => {
    expect(resolveUserDataDir({ ...base, hasUserDataDirSwitch: true })).toBeNull();
    expect(resolveUserDataDir({ ...base, isDev: true, hasUserDataDirSwitch: true })).toBeNull();
  });
});

describe('resolveUserDataDir with HARNESS_DATA_DIR (S8-N3 follow-up)', () => {
  const dir = '/tmp/test';
  const want = path.join(dir, 'electron-profile');

  it('packaged + env -> <dir>/electron-profile; packaged without env -> null', () => {
    expect(resolveUserDataDir({ ...base, isPackaged: true, dataDirEnv: dir })).toBe(want);
    expect(resolveUserDataDir({ ...base, isPackaged: true })).toBeNull();
    expect(resolveUserDataDir({ ...base, isPackaged: true, dataDirEnv: '  ' })).toBeNull();
  });

  it('dev and preview + env -> <dir>/electron-profile', () => {
    expect(resolveUserDataDir({ ...base, isDev: true, dataDirEnv: dir })).toBe(want);
    expect(resolveUserDataDir({ ...base, dataDirEnv: dir })).toBe(want);
  });

  it('explicit --user-data-dir still wins', () => {
    expect(resolveUserDataDir({ ...base, isPackaged: true, hasUserDataDirSwitch: true, dataDirEnv: dir })).toBeNull();
    expect(resolveUserDataDir({ ...base, hasUserDataDirSwitch: true, dataDirEnv: dir })).toBeNull();
  });

  it('resolves the data dir exactly as the backend does (~, relative, absolute, trimmed)', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'startup-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    try {
      for (const input of ['~', '~/x', 'rel/dir', path.join(tmp, 'abs'), `  ${path.join(tmp, 'trim')}  `]) {
        const backend = await backendResolve(input);
        const got = resolveUserDataDir({ ...base, isPackaged: true, dataDirEnv: input });
        expect(got).toBe(path.join(backend, 'electron-profile'));
      }
    } finally {
      vi.restoreAllMocks();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('noSandboxWarning (S8-N2)', () => {
  it('warns only when --no-sandbox is set', () => {
    expect(noSandboxWarning(true)).toContain('--no-sandbox');
    expect(noSandboxWarning(false)).toBeNull();
  });
});
