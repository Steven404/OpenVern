// Preload (sandboxed, so it must be CommonJS: electron-vite emits out/preload/index.cjs).
// Exposes the minimal platform bridge `window.harness` (type: `HarnessBridge` in src/renderer/lib/api-client.ts).

import { contextBridge, ipcRenderer } from 'electron';

// Keep in sync with IPC_PICK_DIRECTORY in src/main/ipc.ts (a sandboxed preload cannot share runtime imports).
const IPC_PICK_DIRECTORY = 'harness:pick-directory';

contextBridge.exposeInMainWorld('harness', {
  isElectron: true,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC_PICK_DIRECTORY),
});
