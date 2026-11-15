// IPC handlers. The folder picker (plan §3.2) and the terminal (docs/terminal-plan.md T1.5) are the only non-HTTP
// channels between renderer and main.

import {
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  type OpenDialogOptions,
} from 'electron';
import { isAppUrl } from './origin';
import { registerTerminalIpc } from './terminal/ipc';
import type { TerminalManager } from './terminal/manager';
import { isTopFrameAppSender } from './terminal/sender';
import { getMainWindow } from './window';

export const IPC_PICK_DIRECTORY = 'openvern:pick-directory';

/** The sending frame shows one of the app's own pages. */
function fromAppPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!event.senderFrame && isAppUrl(event.senderFrame.url);
}

/**
 * The app page in the main window's top frame: the only place terminal events are sent, so the only one that may
 * drive a PTY. A subframe of that page, even a same-origin one, is refused.
 */
function fromMainWindowAppPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isTopFrameAppSender(event, getMainWindow()?.webContents ?? null, isAppUrl);
}

export function registerIpc(deps: { terminals: TerminalManager }): void {
  ipcMain.handle(IPC_PICK_DIRECTORY, async (event): Promise<string | null> => {
    // Only the app's own pages may open the dialog.
    if (!fromAppPage(event)) {
      throw new Error('pickDirectory: untrusted sender');
    }
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ['openDirectory'] };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  registerTerminalIpc({ ipc: ipcMain, manager: deps.terminals, isTrustedSender: fromMainWindowAppPage });
}
