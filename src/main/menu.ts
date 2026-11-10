// Production menu: replace macOS's default, whose View menu offers reload and DevTools.
// Linux and other platforms keep no menu; Cmd+N/B/] remain renderer-owned.
import type { MenuItemConstructorOptions } from 'electron';

export function buildAppMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
  return [{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
}
