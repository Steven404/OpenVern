// Startup decisions that must run before `ready` and the single-instance lock (S8-N3, S8-N2). Pure: no `electron`.

import os from 'node:os';
import path from 'node:path';

export interface UserDataInput {
  isPackaged: boolean;
  isDev: boolean;
  hasUserDataDirSwitch: boolean;
  appDataDir: string;
  /** Raw `HARNESS_DATA_DIR` value, if any. */
  dataDirEnv?: string;
}

/** Sync twin of the backend's `resolveDataDir` path logic (trim, `~` expansion, absolute) without creating anything. */
function resolveDataDirSync(raw: string): string {
  const p = raw.trim();
  const expanded =
    p === '~'
      ? os.homedir()
      : p.startsWith('~/') || p.startsWith(`~${path.sep}`)
        ? path.join(os.homedir(), p.slice(2))
        : p;
  return path.resolve(expanded);
}

/**
 * Profile dir to set before the single-instance lock, or null to keep Electron's default / the explicit switch.
 * With `HARNESS_DATA_DIR` (any mode): `<data dir>/electron-profile`, so a test run is isolated from the installed app.
 * Otherwise packaged: `~/.config/harness` (default); unpackaged: `harness-dev` (`npm run dev`) or `harness-preview`
 * (`npm run preview`, bare `electron .`), so each mode has its own Chromium profile and lock.
 */
export function resolveUserDataDir(i: UserDataInput): string | null {
  if (i.hasUserDataDirSwitch) return null;
  if (i.dataDirEnv?.trim()) return path.join(resolveDataDirSync(i.dataDirEnv), 'electron-profile');
  if (i.isPackaged) return null;
  return path.join(i.appDataDir, i.isDev ? 'harness-dev' : 'harness-preview');
}

export const NO_SANDBOX_WARNING =
  '[harness] WARNING: running with --no-sandbox; renderers are not OS-sandboxed. ' +
  'If this is the AppImage, enable unprivileged user namespaces (or the chrome-sandbox SUID helper).';

export function noSandboxWarning(hasNoSandboxSwitch: boolean): string | null {
  return hasNoSandboxSwitch ? NO_SANDBOX_WARNING : null;
}
