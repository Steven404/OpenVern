// The single BrowserWindow: creation, hardening (plan §3.3) and focus helpers.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, LAYOUT } from '@shared/constants';
import { app, BrowserWindow, shell } from 'electron';
import { devRendererUrl, isAppUrl, PROD_ORIGIN } from './origin';

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** Bring the existing window to the front (second launch). */
export function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function isExternalWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function harden(win: BrowserWindow): void {
  // Never open new Electron windows; http(s) links go to the system browser, everything else is dropped.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The renderer may only ever show the app's own origin (hash-route changes are in-page, not navigations).
  win.webContents.on('will-navigate', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

export function createMainWindow(): BrowserWindow {
  // Dev only: the packaged app gets its icon from electron-builder.
  const devIcon = join(app.getAppPath(), 'build/icon.png');

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: LAYOUT.windowMinWidth,
    minHeight: LAYOUT.windowMinHeight,
    title: APP_NAME,
    backgroundColor: '#0f1428',
    show: false,
    ...(!app.isPackaged && existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: {
      // electron-vite emits the sandbox-compatible CommonJS preload as out/preload/index.cjs.
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.once('ready-to-show', () => win.show());
  harden(win);

  const devUrl = devRendererUrl();
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadURL(`${PROD_ORIGIN}/`);
  }
  return win;
}
