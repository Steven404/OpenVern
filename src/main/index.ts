// Electron main process entry (S8). Dev: loads the Vite dev server; the API runs as a separate process.
// Prod: the backend runs in this process behind `protocol.handle('app', …)` and the window loads `app://openvern/`.

import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu } from 'electron';
import { createBackend } from './backend';
import { registerIpc } from './ipc';
import { buildAppMenuTemplate } from './menu';
import { isDev } from './origin';
import { handleAppProtocol, registerAppScheme } from './protocol';
import { noSandboxWarning, resolveUserDataDir } from './startup';
import { createMainWindow, focusMainWindow } from './window';

// Must happen before `ready`. (Harmless in dev: nothing is served on the scheme there.)
registerAppScheme();

// Per-mode Electron profile (S8-N3). Must precede the single-instance lock, which lives in `userData`.
const profile = resolveUserDataDir({
  isPackaged: app.isPackaged,
  isDev: isDev(),
  hasUserDataDirSwitch: app.commandLine.hasSwitch('user-data-dir'),
  appDataDir: app.getPath('appData'),
  dataDirEnv: process.env.OPENVERN_DATA_DIR,
});
if (profile) app.setPath('userData', profile);
console.log(`[openvern] profile: ${app.getPath('userData')}`);

// The AppImage's AppRun may add --no-sandbox when user namespaces are unavailable (S8-N2); make that visible.
const sandboxWarning = noSandboxWarning(app.commandLine.hasSwitch('no-sandbox'));
if (sandboxWarning) console.warn(sandboxWarning);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(async () => {
    if (!isDev()) {
      const template = buildAppMenuTemplate(process.platform);
      Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null); // dev keeps the default menu (DevTools, reload)
      let backend: Awaited<ReturnType<typeof createBackend>>;
      try {
        backend = await createBackend();
      } catch (err) {
        console.error('[openvern] failed to start the backend:', err);
        dialog.showErrorBox('OpenVern could not start', err instanceof Error ? err.message : String(err));
        app.exit(1);
        return;
      }
      console.log(`[openvern] data dir: ${backend.dataDir}`);
      handleAppProtocol({ fetchApi: backend.fetch, rendererDir: join(import.meta.dirname, '../renderer') });
    }
    registerIpc();
    createMainWindow();

    // Register after startup: a second instance can arrive during createBackend (including a Keychain wait),
    // before the protocol and first window are ready.
    app.on('second-instance', () => {
      if (!focusMainWindow()) createMainWindow();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
