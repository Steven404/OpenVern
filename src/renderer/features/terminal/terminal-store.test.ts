import { TERMINAL } from '@shared/terminal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampDockHeight,
  maxDockHeight,
  selectDockOpen,
  TERMINAL_STORAGE_KEYS,
  useTerminalUiStore,
} from './terminal-store';

const realInnerHeight = window.innerHeight;

/** Sets the window height the dock clamps against. The default test window is 1000 px tall (the dock may be 600 px). */
function setViewportHeight(px: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: px });
}

/** Simulates a reload: a fresh module reads the storage again, as it does when the page loads. */
async function reload() {
  vi.resetModules();
  const fresh = await import('./terminal-store');
  return fresh.useTerminalUiStore.getState();
}

const openNow = (chatId: string) => selectDockOpen(chatId)(useTerminalUiStore.getState());

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  setViewportHeight(1000);
  useTerminalUiStore.setState({ openDocks: {}, focusRequests: {}, dockHeight: TERMINAL.dockDefaultHeight });
});

afterEach(() => {
  setViewportHeight(realInnerHeight);
  vi.restoreAllMocks();
});

describe('which chats have the dock open', () => {
  it('survives a reload of the window, and is kept per chat', async () => {
    useTerminalUiStore.getState().openDock('chat-a');
    const after = await reload();
    expect(selectDockOpen('chat-a')(after)).toBe(true);
    expect(selectDockOpen('chat-b')(after)).toBe(false);
  });

  it('is not carried into a new app session, where sessionStorage is empty', async () => {
    useTerminalUiStore.getState().openDock('chat-a');
    window.sessionStorage.clear();
    const after = await reload();
    expect(selectDockOpen('chat-a')(after)).toBe(false);
  });

  it('opening one chat leaves the others closed, and closing one leaves the rest open', () => {
    const { openDock, closeDock } = useTerminalUiStore.getState();
    openDock('a');
    openDock('b');
    closeDock('a');
    expect(openNow('a')).toBe(false);
    expect(openNow('b')).toBe(true);
    expect(JSON.parse(window.sessionStorage.getItem(TERMINAL_STORAGE_KEYS.openDocks) ?? '[]')).toEqual(['b']);
  });

  it('toggle flips the one chat it is given', () => {
    const { toggleDock } = useTerminalUiStore.getState();
    toggleDock('a');
    expect(openNow('a')).toBe(true);
    toggleDock('b');
    toggleDock('a');
    expect(openNow('a')).toBe(false);
    expect(openNow('b')).toBe(true);
  });

  it('is kept in sessionStorage and not in localStorage', () => {
    useTerminalUiStore.getState().openDock('a');
    expect(window.sessionStorage.getItem(TERMINAL_STORAGE_KEYS.openDocks)).toBe('["a"]');
    expect(window.localStorage.getItem(TERMINAL_STORAGE_KEYS.openDocks)).toBeNull();
  });

  it('a corrupt stored value starts with every dock closed', async () => {
    window.sessionStorage.setItem(TERMINAL_STORAGE_KEYS.openDocks, 'not json{');
    const after = await reload();
    expect(after.openDocks).toEqual({});
  });

  it('an object where the array should be is ignored', async () => {
    window.sessionStorage.setItem(TERMINAL_STORAGE_KEYS.openDocks, '{"a":true}');
    const after = await reload();
    expect(after.openDocks).toEqual({});
  });

  it('drops stored entries that are not chat ids', async () => {
    window.sessionStorage.setItem(TERMINAL_STORAGE_KEYS.openDocks, '[1,null,"b",""]');
    const after = await reload();
    expect(after.openDocks).toEqual({ b: true });
  });

  it('still opens the dock in memory when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => useTerminalUiStore.getState().openDock('a')).not.toThrow();
    expect(openNow('a')).toBe(true);
    const after = await reload();
    expect(after.openDocks).toEqual({});
  });
});

describe('the dock height', () => {
  it('is kept in localStorage and survives a reload', async () => {
    useTerminalUiStore.getState().setDockHeight(350);
    expect(window.localStorage.getItem(TERMINAL_STORAGE_KEYS.dockHeight)).toBe('350');
    const after = await reload();
    expect(after.dockHeight).toBe(350);
  });

  it('is clamped to the minimum and to 60% of the window', () => {
    const { setDockHeight } = useTerminalUiStore.getState();
    expect(maxDockHeight(1000)).toBe(600);
    setDockHeight(40);
    expect(useTerminalUiStore.getState().dockHeight).toBe(TERMINAL.dockMinHeight);
    setDockHeight(900);
    expect(useTerminalUiStore.getState().dockHeight).toBe(600);
    setDockHeight(400);
    expect(useTerminalUiStore.getState().dockHeight).toBe(400);
    expect(clampDockHeight(2000, 720)).toBe(432);
  });

  it('a stored height is clamped on reload', async () => {
    window.localStorage.setItem(TERMINAL_STORAGE_KEYS.dockHeight, '9999');
    expect((await reload()).dockHeight).toBe(600);
    window.localStorage.setItem(TERMINAL_STORAGE_KEYS.dockHeight, '-40');
    expect((await reload()).dockHeight).toBe(TERMINAL.dockMinHeight);
  });

  it('a height stored for a taller window is clamped down when the window is shorter', () => {
    expect(clampDockHeight(500, 600)).toBe(360);
  });

  it('a corrupt stored height falls back to the default', async () => {
    window.localStorage.setItem(TERMINAL_STORAGE_KEYS.dockHeight, 'tall');
    expect((await reload()).dockHeight).toBe(TERMINAL.dockDefaultHeight);
  });

  it('a drag writes nothing until it is committed', () => {
    const { setDockHeight, commitDockHeight } = useTerminalUiStore.getState();
    setDockHeight(300, { persist: false });
    expect(useTerminalUiStore.getState().dockHeight).toBe(300);
    expect(window.localStorage.getItem(TERMINAL_STORAGE_KEYS.dockHeight)).toBeNull();
    commitDockHeight();
    expect(window.localStorage.getItem(TERMINAL_STORAGE_KEYS.dockHeight)).toBe('300');
  });
});

describe('focus requests', () => {
  it('opening a dock asks for focus once, and hiding it does not', () => {
    const { openDock, consumeFocusRequest, toggleDock } = useTerminalUiStore.getState();
    openDock('a');
    expect(consumeFocusRequest('a')).toBe(true);
    expect(consumeFocusRequest('a')).toBe(false);
    toggleDock('a');
    expect(openNow('a')).toBe(false);
    expect(consumeFocusRequest('a')).toBe(false);
  });
});
