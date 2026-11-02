// Global UI state (owned by S6; seeded by the orchestrator so S7 can open modals without depending on S6 code).
// S6 added the sidebar / expansion fields below but kept the original names.

import type { Id } from '@shared/types';
import { create } from 'zustand';

export const STORAGE_KEYS = {
  sidebarCollapsed: 'openvern.sidebarCollapsed',
  expandedProjects: 'openvern.expandedProjects',
} as const;

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
export function readPersistedUi(): Pick<UiState, 'sidebarCollapsed' | 'expandedProjects'> {
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
  return { sidebarCollapsed: readStorage(STORAGE_KEYS.sidebarCollapsed) === '1', expandedProjects };
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
  /** Narrow windows (≤ 760px, D19): the sidebar is an overlay that starts closed and is never persisted. */
  sidebarOverlayOpen: boolean;
  setSidebarOverlayOpen(open: boolean): void;

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
  sidebarOverlayOpen: false,
  setSidebarOverlayOpen: (open) => set({ sidebarOverlayOpen: open }),

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
