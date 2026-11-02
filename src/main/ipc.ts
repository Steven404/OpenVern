// IPC handlers. The folder picker is the only non-HTTP channel between renderer and main (plan §3.2).

import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { isAppUrl } from './origin';

export const IPC_PICK_DIRECTORY = 'openvern:pick-directory';

export function registerIpc(): void {
  ipcMain.handle(IPC_PICK_DIRECTORY, async (event): Promise<string | null> => {
    // Only the app's own pages may open the dialog.
    if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) {
      throw new Error('pickDirectory: untrusted sender');
    }
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ['openDirectory'] };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });
}
