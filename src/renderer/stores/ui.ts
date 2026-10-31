// Global UI state (owned by S6; seeded by the orchestrator so S7 can open modals without depending on S6 code).
// S6 may add fields (e.g. sidebar collapse, project expansion) but must keep these names.

import { create } from 'zustand';

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
}

export const useUiStore = create<UiState>()((set) => ({
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  newProjectOpen: false,
  openNewProject: () => set({ newProjectOpen: true }),
  closeNewProject: () => set({ newProjectOpen: false }),
}));
