// Terminal dock state (terminal plan T3.1): which chats show the dock, and the dock's height.
//
// The open state is kept in `sessionStorage`, so reloading the window keeps the docks that were open and quitting the
// app does not (plan §1.2). The height is a layout preference and is kept in `localStorage`, like the right panel's
// width. Nothing here owns a shell: main does (plan §3), and hiding the dock never closes one.

import { TERMINAL } from '@shared/terminal';
import type { Id } from '@shared/types';
import { create } from 'zustand';

export const TERMINAL_STORAGE_KEYS = {
  openDocks: 'openvern.terminal.openDocks',
  dockHeight: 'openvern.terminal.dockHeight',
  draftProject: 'openvern.terminal.draftProject',
} as const;

/** The dock never takes more than 60% of the window (plan §5). */
export const DOCK_MAX_FRACTION = 0.6;

/** The tallest the dock may be in this window. */
export function maxDockHeight(viewport = window.innerHeight): number {
  return Math.max(TERMINAL.dockMinHeight, Math.round(viewport * DOCK_MAX_FRACTION));
}

/** Clamps a height to `dockMinHeight` … 60% of the window. */
export function clampDockHeight(px: number, viewport = window.innerHeight): number {
  if (!Number.isFinite(px)) return TERMINAL.dockDefaultHeight;
  return Math.min(maxDockHeight(viewport), Math.max(TERMINAL.dockMinHeight, Math.round(px)));
}

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, blocked site data): the state just won't persist.
  }
}

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // As above.
  }
}

function removeSession(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // As above.
  }
}

/** `{ "projectId": <id or null> }`; anything else reads as unknown. */
function readDraftProject(): Id | null | undefined {
  try {
    const raw = readSession(TERMINAL_STORAGE_KEYS.draftProject);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('projectId' in parsed)) return undefined;
    const { projectId } = parsed;
    return projectId === null || (typeof projectId === 'string' && projectId !== '') ? projectId : undefined;
  } catch {
    return undefined;
  }
}

/** Persisted slice of the terminal state. Exported so tests can simulate a reload. */
export function readPersistedTerminal(): Pick<TerminalUiState, 'openDocks' | 'dockHeight' | 'draftProjectId'> {
  let openDocks: Record<Id, true> = {};
  try {
    const parsed: unknown = JSON.parse(readSession(TERMINAL_STORAGE_KEYS.openDocks) ?? '[]');
    if (Array.isArray(parsed)) {
      openDocks = Object.fromEntries(
        parsed.filter((v): v is string => typeof v === 'string' && v !== '').map((id) => [id, true as const]),
      );
    }
  } catch {
    // Corrupt value: start with every dock closed.
  }
  const rawHeight = readLocal(TERMINAL_STORAGE_KEYS.dockHeight);
  return {
    openDocks,
    dockHeight: rawHeight === null ? TERMINAL.dockDefaultHeight : clampDockHeight(Number(rawHeight)),
    draftProjectId: readDraftProject(),
  };
}

export interface TerminalUiState {
  /** Chats whose dock is open (`sessionStorage`: survives a reload, not a restart). */
  openDocks: Record<Id, true>;
  /** Dock height in px (`localStorage`). The user sets it with the drag handle on the dock's top edge. */
  dockHeight: number;
  /**
   * Chats whose dock was just opened by the user, so the dock focuses its terminal on mount. Not persisted: a chat
   * switch mounts the dock too, and that must not pull focus away from the composer.
   */
  focusRequests: Record<Id, true>;
  /**
   * The project the New Chat screen's shell was started for (`null` = none, so Documents), or `undefined` when no
   * draft shell was started in this window session (`sessionStorage`). The shell keeps its folder when the project chip
   * changes; the dock compares this with the chip to say so.
   */
  draftProjectId: Id | null | undefined;

  openDock(chatId: Id): void;
  closeDock(chatId: Id): void;
  toggleDock(chatId: Id): void;
  /**
   * Carries an open dock from `from` to `to` (the New Chat screen's terminal joining the chat created from it). Drops
   * any focus request for either, so the dock does not take focus from the chat's composer after navigation. Nothing
   * happens when `from`'s dock is closed.
   */
  moveDock(from: Id, to: Id): void;
  /** Records the project a new draft shell was started for (see `draftProjectId`); `undefined` forgets it. */
  setDraftProject(projectId: Id | null | undefined): void;
  /** True once per `openDock` / `toggleDock`-while-closed, so the dock knows to focus the terminal. */
  consumeFocusRequest(chatId: Id): boolean;
  /** Drops focus requests that belong to another chat (a switch makes them stale; a later mount must not steal focus). */
  clearFocusRequestsExcept(chatId: Id | undefined): void;
  /** Clamps. Writes storage unless `persist: false` (mid-drag); then call `commitDockHeight` once. */
  setDockHeight(px: number, options?: { persist?: boolean }): void;
  /** Writes the current height to storage. */
  commitDockHeight(): void;
}

function persistOpenDocks(openDocks: Record<Id, true>): void {
  writeSession(TERMINAL_STORAGE_KEYS.openDocks, JSON.stringify(Object.keys(openDocks)));
}

export const useTerminalUiStore = create<TerminalUiState>()((set, get) => ({
  ...readPersistedTerminal(),
  focusRequests: {},

  openDock: (chatId) => {
    set((s) => ({
      openDocks: s.openDocks[chatId] ? s.openDocks : { ...s.openDocks, [chatId]: true },
      focusRequests: { ...s.focusRequests, [chatId]: true },
    }));
    persistOpenDocks(get().openDocks);
  },
  closeDock: (chatId) => {
    if (!get().openDocks[chatId]) return;
    const { [chatId]: _closed, ...openDocks } = get().openDocks;
    // A request for a dock that is closing must not linger and grab focus when the chat is shown again.
    const { [chatId]: _stale, ...focusRequests } = get().focusRequests;
    set({ openDocks, focusRequests });
    persistOpenDocks(openDocks);
  },
  toggleDock: (chatId) => (get().openDocks[chatId] ? get().closeDock(chatId) : get().openDock(chatId)),
  moveDock: (from, to) => {
    if (from === to || !get().openDocks[from]) return;
    const { [from]: _moved, ...rest } = get().openDocks;
    const openDocks: Record<Id, true> = { ...rest, [to]: true };
    const { [from]: _a, [to]: _b, ...focusRequests } = get().focusRequests;
    set({ openDocks, focusRequests });
    persistOpenDocks(openDocks);
  },
  setDraftProject: (projectId) => {
    if (projectId === undefined) removeSession(TERMINAL_STORAGE_KEYS.draftProject);
    else writeSession(TERMINAL_STORAGE_KEYS.draftProject, JSON.stringify({ projectId }));
    set({ draftProjectId: projectId });
  },
  consumeFocusRequest: (chatId) => {
    if (!get().focusRequests[chatId]) return false;
    const { [chatId]: _taken, ...focusRequests } = get().focusRequests;
    set({ focusRequests });
    return true;
  },
  clearFocusRequestsExcept: (chatId) => {
    const next: Record<Id, true> = {};
    if (chatId !== undefined && get().focusRequests[chatId]) next[chatId] = true;
    if (Object.keys(next).length === Object.keys(get().focusRequests).length) return;
    set({ focusRequests: next });
  },
  setDockHeight: (px, options) => {
    const dockHeight = clampDockHeight(px);
    if (options?.persist !== false) writeLocal(TERMINAL_STORAGE_KEYS.dockHeight, String(dockHeight));
    set({ dockHeight });
  },
  commitDockHeight: () => writeLocal(TERMINAL_STORAGE_KEYS.dockHeight, String(get().dockHeight)),
}));

/** Opens the current chat's dock (the launcher's Terminal row, the `Ctrl`+backtick shortcut). */
export function openTerminalDock(chatId: Id): void {
  useTerminalUiStore.getState().openDock(chatId);
}

/** `true` while the dock is open for the chat. */
export const selectDockOpen =
  (chatId: Id | undefined) =>
  (s: TerminalUiState): boolean =>
    chatId !== undefined && s.openDocks[chatId] === true;
