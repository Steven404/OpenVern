// Startup decisions that must run before `ready` and the single-instance lock (S8-N3, S8-N2). Pure: no `electron`.

import os from 'node:os';
import path from 'node:path';
import { APP_SLUG } from '@shared/constants';

export interface UserDataInput {
  isPackaged: boolean;
  isDev: boolean;
  hasUserDataDirSwitch: boolean;
  appDataDir: string;
  /** Raw `OPENVERN_DATA_DIR` value, if any. */
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
 * With `OPENVERN_DATA_DIR` (any mode): `<data dir>/electron-profile`, so a test run is isolated from the installed app.
 * Otherwise packaged: `~/.config/openvern`; unpackaged: `openvern-dev` (`npm run dev`) or `openvern-preview`
 * (`npm run preview`, bare `electron .`), so each mode has its own Chromium profile and lock.
 */
export function resolveUserDataDir(i: UserDataInput): string | null {
  if (i.hasUserDataDirSwitch) return null;
  if (i.dataDirEnv?.trim()) return path.join(resolveDataDirSync(i.dataDirEnv), 'electron-profile');
  // Electron would derive the packaged profile from `productName` ("OpenVern"); keep the lower-case slug (G0.3).
  if (i.isPackaged) return path.join(i.appDataDir, APP_SLUG);
  return path.join(i.appDataDir, i.isDev ? 'openvern-dev' : 'openvern-preview');
}

export const NO_SANDBOX_WARNING =
  '[openvern] WARNING: running with --no-sandbox; renderers are not OS-sandboxed. ' +
  'If this is the AppImage, enable unprivileged user namespaces (or the chrome-sandbox SUID helper).';

export function noSandboxWarning(hasNoSandboxSwitch: boolean): string | null {
  return hasNoSandboxSwitch ? NO_SANDBOX_WARNING : null;
}
