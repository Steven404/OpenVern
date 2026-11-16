// Shell choice and environment (docs/terminal-plan.md §2, T1.1).

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildShellEnv, chooseShell, defaultLang, fallbackShells, isExecutableFile, SHELL_ARGS } from './shell';

/** An `isExecutable` fake that accepts exactly these paths. */
function executables(...paths: string[]): (candidate: string) => boolean {
  const set = new Set(paths);
  return (candidate) => set.has(candidate);
}

describe('chooseShell', () => {
  it('runs $SHELL when it is an absolute path to an executable file', () => {
    expect(chooseShell('/opt/homebrew/bin/fish', 'darwin', executables('/opt/homebrew/bin/fish'))).toBe(
      '/opt/homebrew/bin/fish',
    );
    // It also wins over an executable fallback.
    expect(chooseShell('/usr/local/bin/bash', 'linux', executables('/usr/local/bin/bash', '/bin/bash'))).toBe(
      '/usr/local/bin/bash',
    );
  });

  it('falls back when $SHELL is relative, missing, or not executable', () => {
    const isExecutable = executables('/bin/zsh', '/bin/bash', 'bin/zsh');
    expect(chooseShell('bin/zsh', 'darwin', isExecutable)).toBe('/bin/zsh');
    expect(chooseShell('/no/such/shell', 'darwin', isExecutable)).toBe('/bin/zsh');
    expect(chooseShell(undefined, 'darwin', isExecutable)).toBe('/bin/zsh');
    expect(chooseShell('', 'darwin', isExecutable)).toBe('/bin/zsh');
    // An empty result from the check is a non-executable file.
    expect(chooseShell('/bin/zsh', 'darwin', () => false)).toBe('/bin/sh');
  });

  it('tries the platform fallbacks in order: zsh, bash, sh on macOS', () => {
    expect(fallbackShells('darwin')).toStrictEqual(['/bin/zsh', '/bin/bash', '/bin/sh']);
    expect(chooseShell(undefined, 'darwin', executables('/bin/zsh', '/bin/bash', '/bin/sh'))).toBe('/bin/zsh');
    expect(chooseShell(undefined, 'darwin', executables('/bin/bash', '/bin/sh'))).toBe('/bin/bash');
    expect(chooseShell(undefined, 'darwin', executables('/bin/sh'))).toBe('/bin/sh');
  });

  it('tries bash then sh on the other platforms', () => {
    for (const platform of ['linux', 'win32', 'freebsd'] as const) {
      expect(fallbackShells(platform)).toStrictEqual(['/bin/bash', '/bin/sh']);
      expect(chooseShell(undefined, platform, executables('/bin/zsh', '/bin/bash', '/bin/sh'))).toBe('/bin/bash');
      expect(chooseShell(undefined, platform, executables('/bin/zsh', '/bin/sh'))).toBe('/bin/sh');
    }
  });

  it('uses /bin/sh when no fallback is executable, whatever the platform', () => {
    expect(chooseShell(undefined, 'darwin', () => false)).toBe('/bin/sh');
    expect(chooseShell(undefined, 'linux', () => false)).toBe('/bin/sh');
    expect(chooseShell(undefined, undefined, () => false)).toBe('/bin/sh');
  });

  it('defaults to the current platform', () => {
    const order = fallbackShells(process.platform);
    expect(chooseShell(undefined, undefined, executables(...order))).toBe(order[0]);
  });

  it('starts the shell as a login shell', () => {
    expect(SHELL_ARGS).toStrictEqual(['-l']);
  });
});

describe('isExecutableFile', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'openvern-shell-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const executable = path.join(dir, 'shell');
  const plain = path.join(dir, 'plain.txt');
  writeFileSync(executable, '#!/bin/sh\n');
  chmodSync(executable, 0o755);
  writeFileSync(plain, 'text\n');
  chmodSync(plain, 0o644);

  it('accepts an executable file', () => {
    expect(isExecutableFile(executable)).toBe(true);
  });

  it('rejects a file that is not executable, a directory, and a missing path', () => {
    expect(isExecutableFile(plain)).toBe(false);
    expect(isExecutableFile(dir)).toBe(false);
    expect(isExecutableFile(path.join(dir, 'missing'))).toBe(false);
  });
});

describe('buildShellEnv', () => {
  const base = {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    HOME: '/home/me',
    SHELL: '/bin/zsh',
    TERM: 'dumb',
    OPENVERN_SECRETS: 'app-secret',
    OPENVERN_DATA_DIR: '/tmp/openvern',
    ELECTRON_RENDERER_URL: 'http://localhost:5173/',
    ELECTRON_RUN_AS_NODE: '1',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_lifecycle_event: 'test',
    NODE_OPTIONS: '--max-old-space-size=4096',
    NO_COLOR: '1',
    FORCE_COLOR: '3',
    NPM_CONFIG_REGISTRY: 'kept: it has no npm_ prefix',
    LANG: 'fr_FR.UTF-8',
    UNSET_VALUE: undefined,
  };

  it('drops the app, Electron and npm variables and the colour and Node options', () => {
    const env = buildShellEnv(base, 'darwin');
    for (const dropped of [
      'OPENVERN_SECRETS',
      'OPENVERN_DATA_DIR',
      'ELECTRON_RENDERER_URL',
      'ELECTRON_RUN_AS_NODE',
      'npm_config_registry',
      'npm_lifecycle_event',
      'NODE_OPTIONS',
      'NO_COLOR',
      'FORCE_COLOR',
      'UNSET_VALUE',
    ]) {
      expect(env, dropped).not.toHaveProperty(dropped);
    }
    // Everything else survives, case for case.
    expect(env.PATH).toBe(base.PATH);
    expect(env.HOME).toBe(base.HOME);
    expect(env.SHELL).toBe(base.SHELL);
    expect(env.NPM_CONFIG_REGISTRY).toBe(base.NPM_CONFIG_REGISTRY);
    expect(env.LANG).toBe('fr_FR.UTF-8');
  });

  it('sets the terminal variables, overwriting inherited ones', () => {
    const env = buildShellEnv({ ...base, COLORTERM: '16color', TERM_PROGRAM: 'Apple_Terminal' }, 'darwin');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.TERM_PROGRAM).toBe('OpenVern');
  });

  it('adds a UTF-8 LANG only when none is set', () => {
    expect(buildShellEnv({ PATH: '/bin' }, 'darwin').LANG).toBe('en_US.UTF-8');
    expect(buildShellEnv({ PATH: '/bin' }, 'linux').LANG).toBe('C.UTF-8');
    expect(buildShellEnv({ PATH: '/bin' }, 'win32').LANG).toBe('C.UTF-8');
    expect(defaultLang('darwin')).toBe('en_US.UTF-8');
    expect(defaultLang('linux')).toBe('C.UTF-8');
    expect(buildShellEnv({ LANG: 'de_DE.UTF-8' }, 'linux').LANG).toBe('de_DE.UTF-8');
    expect(buildShellEnv({ LANG: 'en_GB.UTF-8' }, 'darwin').LANG).toBe('en_GB.UTF-8');
    // An empty LANG is no LANG.
    expect(buildShellEnv({ LANG: '' }, 'darwin').LANG).toBe('en_US.UTF-8');
  });

  it('returns a new object and leaves the app environment alone', () => {
    const input = { ...base };
    const env = buildShellEnv(input, 'darwin');
    expect(input).toStrictEqual({ ...base });
    expect(env).not.toBe(input);
    expect('COLORTERM' in input).toBe(false);
  });
});
