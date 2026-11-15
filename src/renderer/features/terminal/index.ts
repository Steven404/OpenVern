export { getTerminalBridge, hasTerminalBridge } from './bridge';
export { isTerminalFocused, TERMINAL_DOCK_SELECTOR } from './dom';
export { terminalSelectionBlock } from './selection';
export { TerminalDock } from './TerminalDock';
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
export { type TerminalHandle, type TerminalPhase, type UseTerminalOptions, useTerminal } from './use-terminal';
export { type TerminalDockState, useCloseDeletedTerminals, useTerminalDock } from './use-terminal-dock';
