// Electron main process entry (S8). Dev: loads the Vite dev server; the API runs as a separate process.
// Prod: the backend runs in this process behind `protocol.handle('app', …)` and the window loads `app://harness/`.

import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu } from 'electron';
import { createBackend } from './backend';
import { registerIpc } from './ipc';
import { isDev } from './origin';
import { handleAppProtocol, registerAppScheme } from './protocol';
import { createMainWindow, focusMainWindow } from './window';

// Must happen before `ready`. (Harmless in dev: nothing is served on the scheme there.)
registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusMainWindow());

  void app.whenReady().then(async () => {
    if (!isDev()) {
      Menu.setApplicationMenu(null); // dev keeps the default menu (DevTools, reload)
      let backend: Awaited<ReturnType<typeof createBackend>>;
      try {
        backend = await createBackend();
      } catch (err) {
        console.error('[harness] failed to start the backend:', err);
        dialog.showErrorBox('harness could not start', err instanceof Error ? err.message : String(err));
        app.exit(1);
        return;
      }
      console.log(`[harness] data dir: ${backend.dataDir}`);
      handleAppProtocol({ fetchApi: backend.fetch, rendererDir: join(import.meta.dirname, '../renderer') });
    }
    registerIpc();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
