// Whether the packaged app copies the 0.1 ("harness") data dir on startup (v0.2 plan G0.4). Pure: no `electron`.

import path from 'node:path';
import { APP_SLUG } from '@shared/constants';

export interface MigrationPolicyInput {
  platform: NodeJS.Platform;
  /** Raw `OPENVERN_DATA_DIR` value, if any. */
  dataDirEnv?: string;
  /** Electron's `userData` dir for this run (startup.ts). */
  userData: string;
}

/**
 * True when `migrateLegacyDataDir` should run: no `OPENVERN_DATA_DIR` override and `userData` is the packaged
 * profile (`<appData>/openvern`), so the legacy dir is its `<appData>/harness` sibling.
 * Never on macOS: 0.1 shipped only for Linux, so a `~/Library/Application Support/harness` folder belongs to some
 * other app and must not be copied into OpenVern's data dir.
 */
export function shouldMigrateLegacy(i: MigrationPolicyInput): boolean {
  if (i.platform === 'darwin') return false;
  return !i.dataDirEnv?.trim() && path.basename(i.userData) === APP_SLUG;
}
