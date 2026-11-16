// Moving the New Chat screen's terminal into the chat created from it (./adopt-draft.ts): main first, then the
// emulator and the dock's open state. Never throws, never loads the registry (and so xterm) on its own.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => import('./test-fakes'));
vi.mock('@xterm/addon-fit', () => import('./test-fakes'));

import { adoptDraftTerminal } from './adopt-draft';
import { setLoadedTerminalRegistry } from './registry-handle';
import { useTerminalUiStore } from './terminal-store';
import { FakeTerminalBridge, installTerminalBridge, resetTerminalFakes } from './test-fakes';

let bridge: FakeTerminalBridge;

beforeEach(() => {
  window.sessionStorage.clear();
  useTerminalUiStore.setState({ openDocks: {}, focusRequests: {}, draftProjectId: undefined });
  resetTerminalFakes();
  bridge = new FakeTerminalBridge();
  installTerminalBridge(bridge);
});

afterEach(() => {
  installTerminalBridge(null);
  setLoadedTerminalRegistry(null);
});

/** Loads the real registry (as showing the dock does) and returns it. */
async function loadRegistry() {
  const module = await import('./registry');
  setLoadedTerminalRegistry(module.terminalRegistry);
  module.terminalRegistry.disposeAll();
  return module.terminalRegistry;
}

describe('adoptDraftTerminal', () => {
  it('moves the session, the emulator and the open dock to the chat, without a focus request', async () => {
    const registry = await loadRegistry();
    const entry = await registry.attach('__draft__', bridge, { cwd: null, defaultFolder: 'documents' });
    useTerminalUiStore.getState().openDock('__draft__');
    useTerminalUiStore.getState().setDraftProject(null);

    await adoptDraftTerminal('chat-1');

    expect(bridge.adopts).toEqual([{ from: '__draft__', to: 'chat-1' }]);
    expect(registry.get('chat-1')).toBe(entry);
    expect(registry.get('__draft__')).toBeUndefined();
    const state = useTerminalUiStore.getState();
    expect(state.openDocks).toEqual({ 'chat-1': true });
    expect(state.focusRequests).toEqual({});
    expect(state.draftProjectId).toBeUndefined();
    expect(window.sessionStorage.getItem('openvern.terminal.draftProject')).toBeNull();
  });

  it('waits for a draft terminal that is still opening before asking main to move it', async () => {
    const registry = await loadRegistry();
    const release = bridge.holdOpens();
    const attaching = registry.attach('__draft__', bridge, { cwd: null });
    let done = false;
    const adopting = adoptDraftTerminal('chat-1').then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.adopts).toEqual([]);
    expect(done).toBe(false);
    release();
    await attaching;
    await adopting;
    expect(bridge.adopts).toEqual([{ from: '__draft__', to: 'chat-1' }]);
    expect(registry.get('chat-1')).toBeDefined();
  });

  it('still asks main when the draft open failed, and then cleans up the draft dock', async () => {
    const registry = await loadRegistry();
    const open = vi.spyOn(bridge, 'open').mockRejectedValueOnce(new Error('At most 8 terminals'));
    useTerminalUiStore.getState().openDock('__draft__');
    await expect(registry.attach('__draft__', bridge, { cwd: null })).rejects.toThrow();
    await adoptDraftTerminal('chat-1');
    expect(open).toHaveBeenCalledTimes(1);
    expect(bridge.adopts).toHaveLength(1);
    expect(useTerminalUiStore.getState().openDocks).toEqual({});
  });

  it('when main moves nothing, ends the draft emulator and closes its dock', async () => {
    const registry = await loadRegistry();
    const entry = await registry.attach('__draft__', bridge, { cwd: null });
    useTerminalUiStore.getState().openDock('__draft__');
    bridge.adoptMode = 'refuse';

    await adoptDraftTerminal('chat-1');

    expect(entry.disposed).toBe(true);
    expect(registry.get('__draft__')).toBeUndefined();
    expect(registry.get('chat-1')).toBeUndefined();
    expect(useTerminalUiStore.getState().openDocks).toEqual({});
    // The shell is not ended from here.
    expect(bridge.closes).toEqual([]);
  });

  it('treats a rejected adopt like a refused one and does not throw', async () => {
    const registry = await loadRegistry();
    await registry.attach('__draft__', bridge, { cwd: null });
    useTerminalUiStore.getState().openDock('__draft__');
    bridge.adoptMode = 'reject';

    await expect(adoptDraftTerminal('chat-1')).resolves.toBeUndefined();
    expect(registry.get('__draft__')).toBeUndefined();
    expect(useTerminalUiStore.getState().openDocks).toEqual({});
  });

  it('moves a hidden session main holds even though no emulator was ever made in this window', async () => {
    bridge.seed('__draft__', { replay: 'hidden' });
    await adoptDraftTerminal('chat-1');
    expect(bridge.adopts).toEqual([{ from: '__draft__', to: 'chat-1' }]);
    expect(bridge.hasSession('chat-1')).toBe(true);
    expect(useTerminalUiStore.getState().openDocks).toEqual({});
  });

  it('does not load the registry (and so xterm) when none was loaded', async () => {
    // Fresh modules: had `./adopt-draft` imported `./registry`, loading it would fill this fresh handle.
    vi.resetModules();
    const handle = await import('./registry-handle');
    const fresh = await import('./adopt-draft');
    await fresh.adoptDraftTerminal('chat-1');
    expect(handle.loadedTerminalRegistry()).toBeNull();
    expect(bridge.adopts).toEqual([{ from: '__draft__', to: 'chat-1' }]);
  });

  it('does nothing without the desktop bridge', async () => {
    installTerminalBridge(null);
    useTerminalUiStore.getState().openDock('__draft__');
    await expect(adoptDraftTerminal('chat-1')).resolves.toBeUndefined();
    expect(bridge.adopts).toEqual([]);
    expect(useTerminalUiStore.getState().openDocks).toEqual({ __draft__: true });
  });
});
