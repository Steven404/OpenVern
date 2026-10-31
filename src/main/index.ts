// Electron main process entry (S8). Dev: loads the Vite dev server; the API runs as a separate process.

import { app, BrowserWindow, Menu } from 'electron';
import { registerIpc } from './ipc';
import { isDev } from './origin';
import { createMainWindow, focusMainWindow } from './window';

// TODO(S8.3): before `app.whenReady()`, call
//   protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true,
//     supportFetchAPI: true, stream: true } }]);
// and, once ready in prod (not isDev()), create `core` via createCore(…) (S8.4 SafeStorageSecretStore) and register
// `protocol.handle('app', …)` in ./protocol.ts: `/api/*` -> createApp(core).fetch, everything else -> built renderer
// files with SPA fallback + CSP. Spike S8.1 (scripts/spikes/protocol-stream) confirmed streaming works that way.

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusMainWindow());

  void app.whenReady().then(() => {
    if (!isDev()) Menu.setApplicationMenu(null); // dev keeps the default menu (DevTools, reload)
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
