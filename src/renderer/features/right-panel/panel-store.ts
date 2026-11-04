// Per-chat right-panel state, kept in memory only (open/closed lives in `stores/ui.ts` and is persisted).
// File tabs, expanded folders and the filter hold paths relative to a root (a project, or home), so each chat's
// state remembers that root (`bindRoot`) and drops its file state when the root changes. `moveChat` carries the
// new-chat screen's state over to the chat created from it.

import { useUiStore } from '@renderer/stores/ui';
import type { Id } from '@shared/types';
import { create } from 'zustand';
import type { SurfaceId } from './surfaces';

/** Panel state for the new-chat screen, which has no chat id yet. */
export const DRAFT_PANEL_CHAT_ID = '__draft__';

/** What the panel body shows. `launcher` is the "Open a panel" list. */
export type PanelTarget = { type: 'launcher' } | { type: 'surface'; id: SurfaceId } | { type: 'file'; path: string };

/** A closable tab after the pinned Files tab: an opened file, or an opened surface such as Diff. */
export type PanelTab = { type: 'file'; path: string } | { type: 'surface'; id: SurfaceId };

export interface ChatPanelState {
  /** `null` = never chosen: Files when enabled, otherwise the launcher. */
  active: PanelTarget | null;
  tabs: PanelTab[];
  /** Latest params passed to `openPanelSurface`, per surface. A new object on every call. */
  params: Partial<Record<SurfaceId, unknown>>;
  /** Files tree: expanded folders and the filter text. */
  expanded: Record<string, true>;
  query: string;
  /** What the file paths above are relative to (`rootKey`). Unset until first bound. */
  root?: string;
}

const EMPTY: ChatPanelState = { active: null, tabs: [], params: {}, expanded: {}, query: '' };

export const tabKey = (t: PanelTab | PanelTarget): string =>
  t.type === 'file' ? `file:${t.path}` : t.type === 'surface' ? `surface:${t.id}` : 'launcher';

/** Identifies the folder the Files surface lists: a project's, or home for a chat without one. */
export const rootKey = (projectId: Id | null): string => (projectId === null ? 'home' : `project:${projectId}`);

/** Drops everything tied to the previous root; keeps surface tabs (Diff), their params and an active surface. */
export function resetFileState(s: ChatPanelState, root: string): ChatPanelState {
  return {
    ...s,
    tabs: s.tabs.filter((t) => t.type !== 'file'),
    active: s.active?.type === 'file' ? null : s.active,
    expanded: {},
    query: '',
    root,
  };
}

interface PanelStore {
  chats: Record<Id, ChatPanelState>;
  show(chatId: Id, target: PanelTarget): void;
  openFile(chatId: Id, path: string): void;
  openSurface(chatId: Id, id: SurfaceId, params?: unknown): void;
  /** Closes a tab. Closing the active one selects its neighbour, else Files. */
  closeTab(chatId: Id, tab: PanelTab): void;
  setQuery(chatId: Id, query: string): void;
  toggleFolder(chatId: Id, path: string): void;
  collapseAll(chatId: Id): void;
  /** Records the root a chat's file paths are relative to; resets file state if it differs from the recorded one. */
  bindRoot(chatId: Id, root: string): void;
  /** Moves a chat's state to another id (new-chat screen -> the chat just created). */
  moveChat(from: Id, to: Id): void;
}

export const usePanelStore = create<PanelStore>()((set) => {
  const update = (chatId: Id, f: (s: ChatPanelState) => Partial<ChatPanelState>) =>
    set((st) => {
      const cur = st.chats[chatId] ?? EMPTY;
      return { chats: { ...st.chats, [chatId]: { ...cur, ...f(cur) } } };
    });
  const withTab = (tabs: PanelTab[], tab: PanelTab) =>
    tabs.some((t) => tabKey(t) === tabKey(tab)) ? tabs : [...tabs, tab];

  return {
    chats: {},
    show: (chatId, target) => update(chatId, () => ({ active: target })),
    openFile: (chatId, path) =>
      update(chatId, (s) => ({ tabs: withTab(s.tabs, { type: 'file', path }), active: { type: 'file', path } })),
    openSurface: (chatId, id, params) =>
      update(chatId, (s) => ({
        tabs: id === 'files' ? s.tabs : withTab(s.tabs, { type: 'surface', id }),
        active: { type: 'surface', id },
        params: { ...s.params, [id]: params ?? {} },
      })),
    closeTab: (chatId, tab) =>
      update(chatId, (s) => {
        const i = s.tabs.findIndex((t) => tabKey(t) === tabKey(tab));
        if (i < 0) return {};
        const tabs = s.tabs.filter((_, j) => j !== i);
        if (!s.active || tabKey(s.active) !== tabKey(tab)) return { tabs };
        const next = tabs[Math.min(i, tabs.length - 1)];
        return { tabs, active: next ?? { type: 'surface', id: 'files' } };
      }),
    setQuery: (chatId, query) => update(chatId, () => ({ query })),
    toggleFolder: (chatId, path) =>
      update(chatId, (s) => {
        const expanded = { ...s.expanded };
        if (expanded[path]) delete expanded[path];
        else expanded[path] = true;
        return { expanded };
      }),
    collapseAll: (chatId) => update(chatId, () => ({ expanded: {} })),
    bindRoot: (chatId, root) =>
      set((st) => {
        const cur = st.chats[chatId] ?? EMPTY;
        if (cur.root === root) return st;
        const next = cur.root === undefined ? { ...cur, root } : resetFileState(cur, root);
        return { chats: { ...st.chats, [chatId]: next } };
      }),
    moveChat: (from, to) =>
      set((st) => {
        const moved = st.chats[from];
        if (!moved) return st;
        const { [from]: _gone, ...rest } = st.chats;
        return { chats: { ...rest, [to]: moved } };
      }),
  };
});

export function useChatPanelState(chatId: Id): ChatPanelState {
  return usePanelStore((s) => s.chats[chatId]) ?? EMPTY;
}

/**
 * Opens the right panel on a surface for a chat (also opens the panel itself). The way other features reach it,
 * e.g. the "Proposed edits" card: `openPanelSurface(chatId, 'diff', { path: 'src/a.ts' })`.
 */
export function openPanelSurface(chatId: Id, id: SurfaceId, params?: unknown): void {
  usePanelStore.getState().openSurface(chatId, id, params);
  useUiStore.getState().setRightPanelOpen(true);
}
