// Per-chat right-panel state, kept in memory only (open/closed lives in `stores/ui.ts` and is persisted).

import { useUiStore } from '@renderer/stores/ui';
import type { Id } from '@shared/types';
import { create } from 'zustand';
import type { SurfaceId } from './surfaces';

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
  /** Width override (px) a surface asked for with `setWidth`. */
  widths: Partial<Record<SurfaceId, number>>;
  /** Files tree: expanded folders and the filter text. */
  expanded: Record<string, true>;
  query: string;
}

const EMPTY: ChatPanelState = { active: null, tabs: [], params: {}, widths: {}, expanded: {}, query: '' };

export const tabKey = (t: PanelTab | PanelTarget): string =>
  t.type === 'file' ? `file:${t.path}` : t.type === 'surface' ? `surface:${t.id}` : 'launcher';

interface PanelStore {
  chats: Record<Id, ChatPanelState>;
  show(chatId: Id, target: PanelTarget): void;
  openFile(chatId: Id, path: string): void;
  openSurface(chatId: Id, id: SurfaceId, params?: unknown): void;
  /** Closes a tab. Closing the active one selects its neighbour, else Files. */
  closeTab(chatId: Id, tab: PanelTab): void;
  setWidth(chatId: Id, id: SurfaceId, px: number | null): void;
  setQuery(chatId: Id, query: string): void;
  toggleFolder(chatId: Id, path: string): void;
  collapseAll(chatId: Id): void;
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
    setWidth: (chatId, id, px) =>
      update(chatId, (s) => {
        const widths = { ...s.widths };
        if (px === null) delete widths[id];
        else widths[id] = px;
        return { widths };
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
