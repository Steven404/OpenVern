// Moving the New Chat screen's terminal into the chat created from it (./adopt-draft.ts): main first, then the
// emulator and the dock's open state. Never throws, never loads the registry (and so xterm) on its own.

import { TERMINAL } from '@shared/terminal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => import('./test-fakes'));
vi.mock('@xterm/addon-fit', () => import('./test-fakes'));

import { adoptDraftTerminal } from './adopt-draft';
import { TERMINAL_RESYNC_PAUSE_MS, TerminalAttachCancelled } from './registry';
import { setLoadedTerminalRegistry, terminalAttachesHeld } from './registry-handle';
import { useTerminalUiStore } from './terminal-store';
import { FakeTerminalBridge, installTerminalBridge, resetTerminalFakes, type Terminal } from './test-fakes';

let bridge: FakeTerminalBridge;

beforeEach(() => {
  window.sessionStorage.clear();
  useTerminalUiStore.setState({ openDocks: {}, focusRequests: {}, draftProjectId: undefined });
  resetTerminalFakes();
  bridge = new FakeTerminalBridge();
  installTerminalBridge(bridge);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

/** What the draft dock asks once an attach has waited out a hand-over: is it still open (`use-terminal.ts`)? */
const draftDockOpen = () => useTerminalUiStore.getState().openDocks.__draft__ === true;

/** Lets every promise that can settle now settle. */
async function flushPromises() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * The reviewer's case: a draft shell main kept with its dock closed (no emulator in this window), and a send whose
 * `adopt` main has carried out but whose reply has not arrived yet. Resolves once `adopt` was sent.
 */
async function sendWithHiddenDraft() {
  bridge.seed('__draft__', { replay: 'pre-chat ' });
  const releaseAdopt = bridge.holdAdopts();
  const adopting = adoptDraftTerminal('chat-1');
  await vi.waitFor(() => expect(bridge.adopts).toEqual([{ from: '__draft__', to: 'chat-1' }]));
  expect(bridge.hasSession('chat-1')).toBe(true);
  return { adopting, releaseAdopt };
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

  it('waits for a draft attach still waiting for a free slot, so the shell it starts moves to the chat', async () => {
    const registry = await loadRegistry();
    for (let i = 0; i < TERMINAL.maxSessions; i++) await registry.attach(`chat-${i + 10}`, bridge, { cwd: null });
    bridge.emitExit('chat-10', { state: 'exited', exitCode: 0, signal: null });
    // The draft attach finds every slot taken and asks main which sessions it holds; that answer is held.
    let answerList: () => void = () => {};
    const list = bridge.list.bind(bridge);
    vi.spyOn(bridge, 'list').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerList = () => void list().then(resolve);
        }),
    );
    const attaching = registry.attach('__draft__', bridge, { cwd: null });
    useTerminalUiStore.getState().openDock('__draft__');
    const adopting = adoptDraftTerminal('chat-1');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(bridge.adopts).toEqual([]);

    answerList();
    const entry = await attaching;
    await adopting;

    expect(bridge.adopts).toEqual([{ from: '__draft__', to: 'chat-1' }]);
    expect(bridge.hasSession('chat-1')).toBe(true);
    expect(bridge.hasSession('__draft__')).toBe(false);
    expect(registry.get('chat-1')).toBe(entry);
    expect(useTerminalUiStore.getState().openDocks).toEqual({ 'chat-1': true });
  });

  it('never lets a recovery of the draft end the shell main moved to the chat', async () => {
    vi.useFakeTimers();
    const registry = await loadRegistry();
    const entry = await registry.attach('__draft__', bridge, { cwd: null });
    bridge.emitData('__draft__', 'pre-chat ');
    // Output the emulator cannot take: it recovers from main's replay after a pause.
    vi.spyOn(entry.term, 'write').mockImplementationOnce(() => {
      throw new Error('overflow');
    });
    bridge.emitData('__draft__', 'lost');

    // Main moves the session at once; its reply, and the reply to any open, arrive later.
    const releaseAdopt = bridge.holdAdopts();
    const releaseOpens = bridge.holdOpens();
    const adopting = adoptDraftTerminal('chat-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.adopts).toEqual([{ from: '__draft__', to: 'chat-1' }]);
    // The recovery comes due while the reply is still on its way.
    await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_PAUSE_MS);
    releaseAdopt();
    await vi.advanceTimersByTimeAsync(0);
    releaseOpens();
    await adopting;
    await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_PAUSE_MS * 4);

    expect(bridge.closes).toEqual([]);
    expect(bridge.hasSession('chat-1')).toBe(true);
    expect(bridge.hasSession('__draft__')).toBe(false);
    expect(bridge.opens.map((open) => open.chatId)).toEqual(['__draft__', 'chat-1']);
    expect(registry.get('chat-1')).toBe(entry);
    expect(entry.disposed).toBe(false);
    expect(entry.notice).toBeNull();
    expect(await registry.read('chat-1', bridge, {})).toMatchObject({ ok: true });
  });

  it('lets a recovery open already sent under the draft id finish before main moves the session', async () => {
    vi.useFakeTimers();
    const registry = await loadRegistry();
    const entry = await registry.attach('__draft__', bridge, { cwd: null });
    vi.spyOn(entry.term, 'write').mockImplementationOnce(() => {
      throw new Error('overflow');
    });
    bridge.emitData('__draft__', 'lost');
    const releaseOpens = bridge.holdOpens();
    await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_PAUSE_MS);
    expect(bridge.opens).toHaveLength(2);

    const adopting = adoptDraftTerminal('chat-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.adopts).toEqual([]);
    releaseOpens();
    await adopting;

    expect(bridge.adopts).toEqual([{ from: '__draft__', to: 'chat-1' }]);
    expect(bridge.opens.map((open) => open.chatId)).toEqual(['__draft__', '__draft__']);
    expect(bridge.closes).toEqual([]);
    expect(registry.get('chat-1')).toBe(entry);
    expect(entry.notice).toBeNull();
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

  describe('a draft attach that starts while main moves the session', () => {
    it('waits for the reply, then stops: no second draft shell, and the chat keeps the original one', async () => {
      const registry = await loadRegistry();
      const { adopting, releaseAdopt } = await sendWithHiddenDraft();
      // Before the reply arrives, the draft dock opens and attaches.
      useTerminalUiStore.getState().openDock('__draft__');
      const dockAttach = registry.attach('__draft__', bridge, {
        cwd: null,
        defaultFolder: 'documents',
        wanted: draftDockOpen,
      });
      await flushPromises();
      expect(bridge.opens).toEqual([]);

      releaseAdopt();
      await adopting;
      await expect(dockAttach).rejects.toBeInstanceOf(TerminalAttachCancelled);

      expect(bridge.opens).toEqual([]);
      expect(bridge.hasSession('__draft__')).toBe(false);
      expect(registry.get('__draft__')).toBeUndefined();
      expect(registry.get('chat-1')).toBeUndefined();
      expect(useTerminalUiStore.getState().openDocks).toEqual({ 'chat-1': true });
      expect(terminalAttachesHeld('__draft__')).toBeUndefined();
      // The chat's dock attaches to the shell that was the draft, its output from before the chat included.
      const entry = await registry.attach('chat-1', bridge, { cwd: null });
      expect(bridge.opens.map((open) => open.chatId)).toEqual(['chat-1']);
      expect((entry.term as unknown as Terminal).writes).toEqual(['pre-chat ']);
      expect(bridge.closes).toEqual([]);
    });

    it('when the draft dock still wants it afterwards, it gets a shell of its own that is never renamed', async () => {
      const registry = await loadRegistry();
      const { adopting, releaseAdopt } = await sendWithHiddenDraft();
      const dockAttach = registry.attach('__draft__', bridge, { cwd: null, wanted: () => true });
      await flushPromises();
      expect(bridge.opens).toEqual([]);

      releaseAdopt();
      await adopting;
      const draft = await dockAttach;

      // Asked for only once the move was done, so it is a new draft shell, and it stays the draft's.
      expect(bridge.opens.map((open) => open.chatId)).toEqual(['__draft__']);
      expect(registry.get('__draft__')).toBe(draft);
      expect(registry.get('chat-1')).toBeUndefined();
      expect(bridge.hasSession('__draft__')).toBe(true);
      expect(bridge.hasSession('chat-1')).toBe(true);
      const chat = await registry.attach('chat-1', bridge, { cwd: null });
      expect(chat).not.toBe(draft);
      expect((chat.term as unknown as Terminal).writes).toEqual(['pre-chat ']);
      expect(bridge.closes).toEqual([]);
    });

    it('a draft emulator made before the send moves; a remount during the send attaches nothing new', async () => {
      const registry = await loadRegistry();
      const entry = await registry.attach('__draft__', bridge, { cwd: null });
      useTerminalUiStore.getState().openDock('__draft__');
      const releaseAdopt = bridge.holdAdopts();
      const adopting = adoptDraftTerminal('chat-1');
      await vi.waitFor(() => expect(bridge.adopts).toHaveLength(1));
      // The dock remounts (a re-render with another folder, say) while the reply is on its way.
      const remount = registry.attach('__draft__', bridge, { cwd: '/elsewhere', wanted: draftDockOpen });

      releaseAdopt();
      await adopting;
      await expect(remount).rejects.toBeInstanceOf(TerminalAttachCancelled);
      expect(registry.get('chat-1')).toBe(entry);
      expect(registry.get('__draft__')).toBeUndefined();
      expect(bridge.opens.map((open) => open.chatId)).toEqual(['__draft__']);
      expect(bridge.hasSession('__draft__')).toBe(false);
    });

    it('lets them go when the adopt is rejected, and a later draft attach still opens', async () => {
      const registry = await loadRegistry();
      bridge.adoptMode = 'reject';
      bridge.seed('__draft__', { replay: 'kept ' });
      const releaseAdopt = bridge.holdAdopts();
      const adopting = adoptDraftTerminal('chat-1');
      await vi.waitFor(() => expect(bridge.adopts).toHaveLength(1));
      useTerminalUiStore.getState().openDock('__draft__');
      const dockAttach = registry.attach('__draft__', bridge, { cwd: null, wanted: draftDockOpen });
      await flushPromises();
      expect(bridge.opens).toEqual([]);

      releaseAdopt();
      await expect(adopting).resolves.toBeUndefined();
      // The send closed the draft dock, so the attach it held is no longer wanted.
      await expect(dockAttach).rejects.toBeInstanceOf(TerminalAttachCancelled);
      expect(terminalAttachesHeld('__draft__')).toBeUndefined();
      expect(bridge.opens).toEqual([]);

      // Main kept the draft shell: the next time the dock opens it attaches to it, with no wait.
      useTerminalUiStore.getState().openDock('__draft__');
      const later = await registry.attach('__draft__', bridge, { cwd: null, wanted: draftDockOpen });
      expect(bridge.opens.map((open) => open.chatId)).toEqual(['__draft__']);
      expect((later.term as unknown as Terminal).writes).toEqual(['kept ']);
    });

    it.each([
      ['settle', 'before main is asked'],
      ['rename', 'after main moved the session'],
    ] as const)('lets them go when %s throws (%s), and the send goes on', async (method, _when) => {
      const registry = await loadRegistry();
      const entry = await registry.attach('__draft__', bridge, { cwd: null });
      useTerminalUiStore.getState().openDock('__draft__');
      if (method === 'settle') vi.spyOn(registry, 'settle').mockRejectedValueOnce(new Error('boom'));
      else
        vi.spyOn(registry, 'rename').mockImplementationOnce(() => {
          throw new Error('boom');
        });
      const releaseAdopt = bridge.holdAdopts();
      const adopting = adoptDraftTerminal('chat-1');
      const held = registry.attach('__draft__', bridge, { cwd: null, wanted: draftDockOpen });
      await flushPromises();

      releaseAdopt();
      await expect(adopting).resolves.toBeUndefined();
      expect(terminalAttachesHeld('__draft__')).toBeUndefined();
      // The dock was left open by the failed send: the held attach goes on, to the emulator still there.
      await expect(held).resolves.toBe(entry);
      expect(bridge.opens).toHaveLength(1);
    });

    it('a draft attach that finds the entry made while it waited for a slot does not wait for the hand-over', async () => {
      const registry = await loadRegistry();
      for (let i = 0; i < TERMINAL.maxSessions; i++) await registry.attach(`chat-${i + 10}`, bridge, { cwd: null });
      bridge.emitExit('chat-10', { state: 'exited', exitCode: 0, signal: null });
      // Two draft attaches find every slot taken and ask main which sessions it holds; both answers are held.
      const answers: (() => void)[] = [];
      const list = bridge.list.bind(bridge);
      const heldList = () =>
        new Promise<Awaited<ReturnType<typeof list>>>((resolve) => {
          answers.push(() => void list().then(resolve));
        });
      vi.spyOn(bridge, 'list').mockImplementationOnce(heldList).mockImplementationOnce(heldList);
      const first = registry.attach('__draft__', bridge, { cwd: null });
      const second = registry.attach('__draft__', bridge, { cwd: null });
      const adopting = adoptDraftTerminal('chat-1');
      await flushPromises();
      expect(answers).toHaveLength(2);

      // The first makes the entry; the second then finds it while the hand-over is waiting for both.
      answers[0]?.();
      const entry = await first;
      answers[1]?.();
      await expect(second).resolves.toBe(entry);
      await adopting;

      expect(bridge.adopts).toEqual([{ from: '__draft__', to: 'chat-1' }]);
      expect(registry.get('chat-1')).toBe(entry);
      expect(bridge.opens.filter((open) => open.chatId === '__draft__')).toHaveLength(1);
    });
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
