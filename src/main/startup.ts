// Startup decisions that must run before `ready` and the single-instance lock (S8-N3, S8-N2). Pure: no `electron`.

import path from 'node:path';

export interface UserDataInput {
  isPackaged: boolean;
  isDev: boolean;
  hasUserDataDirSwitch: boolean;
  appDataDir: string;
}

/**
 * Profile dir to set before the single-instance lock, or null to keep Electron's default / the explicit switch.
 * Packaged: `~/.config/harness` (default). Unpackaged: `harness-dev` (`npm run dev`) or `harness-preview`
 * (`npm run preview`, bare `electron .`), so each mode has its own Chromium profile and lock.
 */
export function resolveUserDataDir(i: UserDataInput): string | null {
  if (i.isPackaged || i.hasUserDataDirSwitch) return null;
  return path.join(i.appDataDir, i.isDev ? 'harness-dev' : 'harness-preview');
}

export const NO_SANDBOX_WARNING =
  '[harness] WARNING: running with --no-sandbox; renderers are not OS-sandboxed. ' +
  'If this is the AppImage, enable unprivileged user namespaces (or the chrome-sandbox SUID helper).';

export function noSandboxWarning(hasNoSandboxSwitch: boolean): string | null {
  return hasNoSandboxSwitch ? NO_SANDBOX_WARNING : null;
}
