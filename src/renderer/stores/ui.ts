// Global UI state (owned by S6; seeded by the orchestrator so S7 can open modals without depending on S6 code).
// S6 added the sidebar / expansion fields below but kept the original names.

import { LAYOUT } from '@shared/constants';
import type { Id } from '@shared/types';
import { create } from 'zustand';

export const STORAGE_KEYS = {
  sidebarCollapsed: 'openvern.sidebarCollapsed',
  expandedProjects: 'openvern.expandedProjects',
  rightPanelOpen: 'openvern.rightPanelOpen',
  rightPanelWidth: 'openvern.rightPanelWidth',
} as const;

/** Hard cap so a bad stored value cannot cover the window. The layout also clamps to the space beside the chat. */
const PANEL_WIDTH_CAP = 2400;

export function clampPanelWidth(px: number): number {
  if (!Number.isFinite(px)) return LAYOUT.panelFiles;
  return Math.min(PANEL_WIDTH_CAP, Math.max(LAYOUT.panelMin, Math.round(px)));
}

function readPanelWidth(): number {
  const raw = readStorage(STORAGE_KEYS.rightPanelWidth);
  if (raw === null) return LAYOUT.panelFiles;
  return clampPanelWidth(Number(raw));
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, blocked site data): the state just won't persist.
  }
}

/** Persisted slice of the UI state. Exported so tests can simulate a reload. */
export function readPersistedUi(): Pick<
  UiState,
  'sidebarCollapsed' | 'expandedProjects' | 'rightPanelOpen' | 'rightPanelWidth'
> {
  let expandedProjects: Record<Id, true> = {};
  try {
    const parsed: unknown = JSON.parse(readStorage(STORAGE_KEYS.expandedProjects) ?? '[]');
    if (Array.isArray(parsed)) {
      expandedProjects = Object.fromEntries(
        parsed.filter((v): v is string => typeof v === 'string').map((id) => [id, true as const]),
      );
    }
  } catch {
    // Corrupt value: start with everything collapsed.
  }
  return {
    sidebarCollapsed: readStorage(STORAGE_KEYS.sidebarCollapsed) === '1',
    expandedProjects,
    rightPanelOpen: readStorage(STORAGE_KEYS.rightPanelOpen) === '1',
    rightPanelWidth: readPanelWidth(),
  };
}

/**
 * Where focus returns when an app-level modal (Settings, New project) closes. The modals are driven by store state,
 * so there is no `DialogTrigger`; `openSettings` / `openNewProject` remember the element that had focus.
 */
export const modalReturnFocus: { current: HTMLElement | null } = { current: null };

function rememberFocus(): void {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) {
    modalReturnFocus.current = null;
    return;
  }
  // A menu item unmounts when its menu closes; remember the menu's trigger instead.
  const menu = el.closest('[role="menu"]');
  if (menu?.id) {
    const trigger = Array.from(document.querySelectorAll<HTMLElement>('[aria-controls]')).find(
      (candidate) => candidate.getAttribute('aria-controls') === menu.id,
    );
    if (trigger) {
      modalReturnFocus.current = trigger;
      return;
    }
  }
  modalReturnFocus.current = el;
}

export interface UiState {
  settingsOpen: boolean;
  /** Opens the Settings modal (S6 renders it; S7 calls this from the no-key notice, model picker, error card). */
  openSettings(): void;
  closeSettings(): void;
  newProjectOpen: boolean;
  /**
   * Opens the New project modal (S6). On success the modal itself expands the project in the sidebar and
   * navigates to `paths.newChat(project.id)`, so callers (e.g. S7's project chip "Add project…") need no callback.
   */
  openNewProject(): void;
  closeNewProject(): void;

  /** Desktop sidebar collapse (D2). Persisted in `localStorage` (`openvern.sidebarCollapsed`). */
  sidebarCollapsed: boolean;
  setSidebarCollapsed(collapsed: boolean): void;
  toggleSidebarCollapsed(): void;

  /** Right panel (Files / Terminal / Diff) open state. Persisted in `localStorage` (`openvern.rightPanelOpen`). */
  rightPanelOpen: boolean;
  setRightPanelOpen(open: boolean): void;
  toggleRightPanel(): void;

  /** Right panel width in px. Persisted (`openvern.rightPanelWidth`). The user sets it with the resize handle. */
  rightPanelWidth: number;
  /** Clamps. Writes storage unless `persist: false` (mid-drag); then call `commitRightPanelWidth` once. */
  setRightPanelWidth(px: number, options?: { persist?: boolean }): void;
  /** Writes the current width to storage. */
  commitRightPanelWidth(): void;

  /** Expanded project rows in the sidebar (D5), by project id. Persisted (`openvern.expandedProjects`). */
  expandedProjects: Record<Id, true>;
  toggleProject(id: Id): void;
  expandProject(id: Id): void;
  collapseProject(id: Id): void;
}

function persistExpanded(expanded: Record<Id, true>): void {
  writeStorage(STORAGE_KEYS.expandedProjects, JSON.stringify(Object.keys(expanded)));
}

export const useUiStore = create<UiState>()((set, get) => ({
  settingsOpen: false,
  openSettings: () => {
    rememberFocus();
    set({ settingsOpen: true });
  },
  closeSettings: () => set({ settingsOpen: false }),
  newProjectOpen: false,
  openNewProject: () => {
    rememberFocus();
    set({ newProjectOpen: true });
  },
  closeNewProject: () => set({ newProjectOpen: false }),

  ...readPersistedUi(),
  setSidebarCollapsed: (collapsed) => {
    writeStorage(STORAGE_KEYS.sidebarCollapsed, collapsed ? '1' : '0');
    set({ sidebarCollapsed: collapsed });
  },
  toggleSidebarCollapsed: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
  setRightPanelOpen: (open) => {
    writeStorage(STORAGE_KEYS.rightPanelOpen, open ? '1' : '0');
    set({ rightPanelOpen: open });
  },
  toggleRightPanel: () => get().setRightPanelOpen(!get().rightPanelOpen),
  setRightPanelWidth: (px, options) => {
    const rightPanelWidth = clampPanelWidth(px);
    if (options?.persist !== false) writeStorage(STORAGE_KEYS.rightPanelWidth, String(rightPanelWidth));
    set({ rightPanelWidth });
  },
  commitRightPanelWidth: () => writeStorage(STORAGE_KEYS.rightPanelWidth, String(get().rightPanelWidth)),

  toggleProject: (id) => (get().expandedProjects[id] ? get().collapseProject(id) : get().expandProject(id)),
  expandProject: (id) => {
    if (get().expandedProjects[id]) return;
    const expandedProjects = { ...get().expandedProjects, [id]: true as const };
    persistExpanded(expandedProjects);
    set({ expandedProjects });
  },
  collapseProject: (id) => {
    if (!get().expandedProjects[id]) return;
    const { [id]: _removed, ...expandedProjects } = get().expandedProjects;
    persistExpanded(expandedProjects);
    set({ expandedProjects });
  },
}));
