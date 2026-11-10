import { describe, expect, it } from 'vitest';
import { shouldMigrateLegacy } from './migration-policy';

describe('legacy migration policy', () => {
  it('only migrates the packaged profile without an override outside macOS', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const dataDirEnv of [undefined, '', '  ', '/custom']) {
        for (const basename of ['openvern', 'openvern-dev', 'openvern-preview', 'electron-profile', 'OpenVern']) {
          expect(shouldMigrateLegacy({ platform, dataDirEnv, userData: `/tmp/${basename}` })).toBe(
            platform !== 'darwin' && !dataDirEnv?.trim() && basename === 'openvern',
          );
        }
      }
    }
  });
});
