// Preload (sandboxed, so it must be CommonJS: electron-vite emits out/preload/index.cjs).
// Exposes the minimal platform bridge `window.openvern` (type: `OpenVernBridge` in src/renderer/lib/api-client.ts).

import type {
  TerminalBridge,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOpenRequest,
  TerminalOpenResult,
  TerminalReadAnswer,
  TerminalReadRequest,
} from '@shared/terminal';
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';

// Keep in sync with IPC_PICK_DIRECTORY in src/main/ipc.ts (a sandboxed preload cannot share runtime imports).
const IPC_PICK_DIRECTORY = 'openvern:pick-directory';

// Keep in sync with TERMINAL_IPC in src/shared/terminal.ts, for the same reason.
export const PRELOAD_TERMINAL_IPC = {
  open: 'openvern:terminal:open',
  read: 'openvern:terminal:read',
  close: 'openvern:terminal:close',
  write: 'openvern:terminal:write',
  resize: 'openvern:terminal:resize',
  data: 'openvern:terminal:data',
  exit: 'openvern:terminal:exit',
} as const;
const IPC = PRELOAD_TERMINAL_IPC;

/** Subscribes to a main → renderer channel, passing the payload only (never the IPC event). */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const terminal: TerminalBridge = {
  open: (req: TerminalOpenRequest): Promise<TerminalOpenResult> => ipcRenderer.invoke(IPC.open, req),
  write: (chatId, data) => ipcRenderer.send(IPC.write, chatId, data),
  resize: (chatId, cols, rows) => ipcRenderer.send(IPC.resize, chatId, cols, rows),
  read: (chatId, req: TerminalReadRequest): Promise<TerminalReadAnswer> => ipcRenderer.invoke(IPC.read, chatId, req),
  close: (chatId): Promise<void> => ipcRenderer.invoke(IPC.close, chatId),
  onData: (listener) => subscribe<TerminalDataEvent>(IPC.data, listener),
  onExit: (listener) => subscribe<TerminalExitEvent>(IPC.exit, listener),
};

contextBridge.exposeInMainWorld('openvern', {
  isElectron: true,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC_PICK_DIRECTORY),
  terminal,
});
