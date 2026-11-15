// The one place the renderer reaches the terminal bridge (terminal plan §4.1). `window.openvern.terminal` is set by
// the preload in Electron and absent in the web build, so every terminal entry point asks here first.

import type { TerminalBridge } from '@shared/terminal';

/** The PTY bridge from the preload, or `null` in the web build. */
export function getTerminalBridge(): TerminalBridge | null {
  return window.openvern?.terminal ?? null;
}

/** True in Electron with the terminal bridge (the dock, the launcher row and `terminal: true` are gated on this). */
export function hasTerminalBridge(): boolean {
  return getTerminalBridge() !== null;
}
