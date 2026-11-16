// Which shell the terminal runs, and with what environment (docs/terminal-plan.md §2). Pure apart from the default
// file check, which callers (and tests) can replace.

import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** A login shell, so it gets the user's PATH when the app is launched from the dock or a launcher. */
export const SHELL_ARGS: readonly string[] = ['-l'];

const FALLBACKS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['/bin/zsh', '/bin/bash', '/bin/sh'],
};
const DEFAULT_FALLBACKS: readonly string[] = ['/bin/bash', '/bin/sh'];

export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The fallback shells for a platform, in the order they are tried. */
export function fallbackShells(platform: NodeJS.Platform): readonly string[] {
  return FALLBACKS[platform] ?? DEFAULT_FALLBACKS;
}

/**
 * `$SHELL` when it is an absolute path to an executable file, else the first executable fallback for the platform
 * (`/bin/zsh` on macOS, then `/bin/bash`, then `/bin/sh`). `/bin/sh` when nothing passes the check.
 */
export function chooseShell(
  envShell: string | undefined,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = isExecutableFile,
): string {
  if (envShell && isAbsolute(envShell) && isExecutable(envShell)) return envShell;
  return fallbackShells(platform).find((path) => isExecutable(path)) ?? '/bin/sh';
}

// The app's own variables, and ones that change how tools inside the shell behave (Hermes saw both break shells).
const DROPPED_PREFIXES = ['OPENVERN_', 'ELECTRON_', 'npm_'];
const DROPPED_NAMES = new Set(['NODE_OPTIONS', 'NO_COLOR', 'FORCE_COLOR']);

export function isDroppedVariable(name: string): boolean {
  return DROPPED_NAMES.has(name) || DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The UTF-8 locale added when the app's environment has no `LANG`. */
export function defaultLang(platform: NodeJS.Platform): string {
  // Every macOS has en_US.UTF-8; on Linux only C.UTF-8 is reliably installed.
  return platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
}

/**
 * The shell's environment: the app's, minus `OPENVERN_*`, `ELECTRON_*`, `npm_*`, `NODE_OPTIONS`, `NO_COLOR` and
 * `FORCE_COLOR`, plus the terminal's own variables and a UTF-8 `LANG` when none is set.
 */
export function buildShellEnv(
  base: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isDroppedVariable(name)) env[name] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'OpenVern';
  if (!env.LANG) env.LANG = defaultLang(platform);
  return env;
}
