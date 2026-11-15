export { getTerminalBridge, hasTerminalBridge } from './bridge';
export { isTerminalFocused, TERMINAL_DOCK_SELECTOR } from './dom';
export { terminalSelectionBlock } from './selection';
export {
  clampDockHeight,
  DOCK_MAX_FRACTION,
  maxDockHeight,
  openTerminalDock,
  readPersistedTerminal,
  selectDockOpen,
  TERMINAL_STORAGE_KEYS,
  type TerminalUiState,
  useTerminalUiStore,
} from './terminal-store';
export { type TerminalDockState, useCloseDeletedTerminals, useTerminalDock } from './use-terminal-dock';
// `TerminalDock` and `useTerminal` are deliberately not re-exported: they pull in xterm and its stylesheet, and the
// app loads the dock with `React.lazy` so the web build never pays for it.
