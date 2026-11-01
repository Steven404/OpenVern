import path from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('noSandboxWarning (S8-N2)', () => {
  it('warns only when --no-sandbox is set', () => {
    expect(noSandboxWarning(true)).toContain('--no-sandbox');
    expect(noSandboxWarning(false)).toBeNull();
  });
});
