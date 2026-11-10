import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveDataDir as backendResolve } from '../core/storage/paths';
import { NO_SANDBOX_WARNING, noSandboxWarning, resolveUserDataDir } from './startup';

const appDataDir = '/home/u/.config';
const base = { isPackaged: false, isDev: false, hasUserDataDirSwitch: false, appDataDir };

describe('resolveUserDataDir (S8-N3)', () => {
  it('uses ~/.config/openvern when packaged (not the productName)', () => {
    expect(resolveUserDataDir({ ...base, isPackaged: true })).toBe(path.join(appDataDir, 'openvern'));
    expect(resolveUserDataDir({ ...base, isPackaged: true, hasUserDataDirSwitch: true })).toBeNull();
  });

  it('uses openvern-dev for unpackaged dev', () => {
    expect(resolveUserDataDir({ ...base, isDev: true })).toBe(path.join(appDataDir, 'openvern-dev'));
  });

  it('uses openvern-preview for unpackaged non-dev (preview / bare electron .)', () => {
    expect(resolveUserDataDir(base)).toBe(path.join(appDataDir, 'openvern-preview'));
  });

  it('leaves an explicit --user-data-dir alone', () => {
    expect(resolveUserDataDir({ ...base, hasUserDataDirSwitch: true })).toBeNull();
    expect(resolveUserDataDir({ ...base, isDev: true, hasUserDataDirSwitch: true })).toBeNull();
  });
});

describe('resolveUserDataDir with OPENVERN_DATA_DIR (S8-N3 follow-up)', () => {
  const dir = '/tmp/test';
  const want = path.join(dir, 'electron-profile');

  it('packaged + env -> <dir>/electron-profile; packaged without env -> openvern profile', () => {
    expect(resolveUserDataDir({ ...base, isPackaged: true, dataDirEnv: dir })).toBe(want);
    expect(resolveUserDataDir({ ...base, isPackaged: true })).toBe(path.join(appDataDir, 'openvern'));
    expect(resolveUserDataDir({ ...base, isPackaged: true, dataDirEnv: '  ' })).toBe(path.join(appDataDir, 'openvern'));
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

describe('resolveUserDataDir on macOS (AS-04 d)', () => {
  const macAppData = '/Users/u/Library/Application Support';
  const mac = { ...base, appDataDir: macAppData };

  it('uses openvern, openvern-dev and openvern-preview under Application Support', () => {
    expect(resolveUserDataDir({ ...mac, isPackaged: true })).toBe(path.join(macAppData, 'openvern'));
    expect(resolveUserDataDir({ ...mac, isDev: true })).toBe(path.join(macAppData, 'openvern-dev'));
    expect(resolveUserDataDir(mac)).toBe(path.join(macAppData, 'openvern-preview'));
  });

  it('OPENVERN_DATA_DIR gives <dir>/electron-profile and an explicit --user-data-dir gives null', () => {
    const dir = '/Users/u/openvern-test';
    expect(resolveUserDataDir({ ...mac, isPackaged: true, dataDirEnv: dir })).toBe(path.join(dir, 'electron-profile'));
    expect(resolveUserDataDir({ ...mac, dataDirEnv: dir })).toBe(path.join(dir, 'electron-profile'));
    expect(resolveUserDataDir({ ...mac, isPackaged: true, hasUserDataDirSwitch: true })).toBeNull();
  });
});

describe('noSandboxWarning by platform (AS-04 e)', () => {
  it('Linux text is unchanged byte for byte (historical literal)', () => {
    expect(NO_SANDBOX_WARNING).toBe(
      '[openvern] WARNING: running with --no-sandbox; renderers are not OS-sandboxed. ' +
        'If this is the AppImage, enable unprivileged user namespaces (or the chrome-sandbox SUID helper).',
    );
    expect(noSandboxWarning(true, 'linux')).toBe(NO_SANDBOX_WARNING);
  });

  it.each(['darwin', 'win32'] as const)('%s text contains --no-sandbox and not AppImage', (platform) => {
    const text = noSandboxWarning(true, platform);
    expect(text).toContain('--no-sandbox');
    expect(text).not.toContain('AppImage');
  });

  it.each(['linux', 'darwin', 'win32'] as const)('%s returns null without --no-sandbox', (platform) => {
    expect(noSandboxWarning(false, platform)).toBeNull();
  });
});
