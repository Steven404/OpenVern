// Wires the terminal manager to the real world: node-pty, the user's shell and environment, the file system, the
// own-child check, and the main window as the only receiver of `data` and `exit` events.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { TERMINAL_IPC } from '@shared/terminal';
import { app, type BrowserWindow } from 'electron';
import { type IPty, spawn } from 'node-pty';
import { isAppUrl } from '../origin';
import { TerminalManager } from './manager';
import { closeWithoutSignal, pendingWriteBytes } from './node-pty-internals';
import { createIsOwnChild } from './own-child';
import type { SpawnPty } from './pty';
import { buildShellEnv, chooseShell, SHELL_ARGS } from './shell';

const spawnNodePty: SpawnPty = (file, args, options) => {
  const pty: IPty = spawn(file, [...args], options);
  const pid = pty.pid;
  return {
    pid,
    onData: (listener) => pty.onData(listener),
    onExit: (listener) => pty.onExit(listener),
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    // What node-pty's own kill() does, without going through it (see closeWithoutSignal).
    kill: (signal) => process.kill(pid, signal),
    close: () => closeWithoutSignal(pty),
    pendingInputBytes: () => pendingWriteBytes(pty),
  };
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `getWindow` returns the main window, or null when there is none. */
export function createTerminalManager(getWindow: () => BrowserWindow | null): TerminalManager {
  const send = (channel: string, payload: unknown) => {
    const contents = getWindow()?.webContents;
    // Only to the app's own page: never to a window that somehow ended up elsewhere.
    if (!contents || contents.isDestroyed() || !isAppUrl(contents.getURL())) return;
    contents.send(channel, payload);
  };
  return new TerminalManager({
    spawn: spawnNodePty,
    shell: () => ({ file: chooseShell(process.env.SHELL), args: SHELL_ARGS, env: buildShellEnv(process.env) }),
    homeDir: homedir,
    documentsDir: () => {
      try {
        return app.getPath('documents');
      } catch {
        return null;
      }
    },
    isDirectory,
    isOwnChild: createIsOwnChild(),
    events: {
      data: (event) => send(TERMINAL_IPC.data, event),
      exit: (event) => send(TERMINAL_IPC.exit, event),
    },
  });
}
