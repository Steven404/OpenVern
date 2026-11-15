import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// xterm cannot draw in jsdom: the terminal and its fit addon are recording fakes (see `test-fakes.ts`).
vi.mock('@xterm/xterm', () => import('./test-fakes'));
vi.mock('@xterm/addon-fit', () => import('./test-fakes'));

import { FakeTerminalBridge, FitAddon, resetTerminalFakes, Terminal } from './test-fakes';
import { type TerminalHandle, useTerminal } from './use-terminal';

const CHAT = 'chat-1';

/** `ResizeObserver` that the test fires by hand, so a host resize is something the test does on purpose. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  trigger(): void {
    this.callback();
  }
}

/** Renders the hook into a host element, as the dock does. `into` always holds the latest result. */
function Harness({
  chatId,
  bridge,
  into,
}: {
  chatId: string;
  bridge: FakeTerminalBridge;
  into: { current: TerminalHandle | null };
}) {
  const terminal = useTerminal(chatId, { cwd: null, bridge });
  into.current = terminal;
  return <div ref={terminal.containerRef} data-testid="host" />;
}

function mount(bridge = new FakeTerminalBridge(), chatId = CHAT) {
  const into: { current: TerminalHandle | null } = { current: null };
  const view = render(<Harness chatId={chatId} bridge={bridge} into={into} />);
  const running = () => waitFor(() => expect(into.current?.phase).toBe('running'));
  return { ...view, bridge, into, running };
}

beforeEach(() => {
  resetTerminalFakes();
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useTerminal: attaching and writing output', () => {
  it('a new session writes nothing before data arrives, then writes what arrives', async () => {
    const { bridge, running } = mount();
    await running();
    expect(bridge.opens).toHaveLength(1);
    expect(bridge.opens[0]).toMatchObject({ chatId: CHAT, cwd: null });
    expect(Terminal.last().writes).toEqual([]);

    bridge.emitData(CHAT, 'hello\r\n', 1);
    expect(Terminal.last().writes).toEqual(['hello\r\n']);
  });

  it('attaching writes the snapshot once, then ignores events at or below its sequence number', async () => {
    const bridge = new FakeTerminalBridge();
    bridge.seed(CHAT, { snapshot: 'SNAPSHOT', seq: 5 });
    const { running } = mount(bridge);
    await running();
    expect(Terminal.last().writes).toEqual(['SNAPSHOT']);

    bridge.emitData(CHAT, 'same', 5);
    bridge.emitData(CHAT, 'older', 3);
    expect(Terminal.last().writes).toEqual(['SNAPSHOT']);

    bridge.emitData(CHAT, 'fresh', 6);
    expect(Terminal.last().writes).toEqual(['SNAPSHOT', 'fresh']);
  });

  it('events that arrive before open resolves are kept only above the snapshot, and written in order', async () => {
    const bridge = new FakeTerminalBridge();
    bridge.seed(CHAT, { snapshot: 'SNAPSHOT', seq: 5 });
    const release = bridge.holdOpens();
    const { running } = mount(bridge);

    bridge.emitData(CHAT, 'seven', 7);
    bridge.emitData(CHAT, 'four', 4);
    bridge.emitData(CHAT, 'six', 6);
    bridge.emitData(CHAT, 'five', 5);
    expect(Terminal.last().writes).toEqual([]);

    release();
    await running();
    expect(Terminal.last().writes).toEqual(['SNAPSHOT', 'six', 'seven']);
  });

  it('events for another chat are ignored, including its exit', async () => {
    const { bridge, into, running } = mount();
    await running();
    bridge.emitData('chat-2', 'not mine', 1);
    act(() => bridge.emitExit('chat-2', { state: 'exited', exitCode: 0, signal: null }));
    expect(Terminal.last().writes).toEqual([]);
    expect(into.current?.phase).toBe('running');

    bridge.emitData(CHAT, 'mine', 1);
    expect(Terminal.last().writes).toEqual(['mine']);
  });

  it('shows the error when the shell cannot be opened', async () => {
    const bridge = new FakeTerminalBridge();
    bridge.open = async () => {
      throw new Error('Too many terminals are open.');
    };
    const { into } = mount(bridge);
    await waitFor(() => expect(into.current?.phase).toBe('error'));
    expect(into.current?.error).toBe('Too many terminals are open.');
  });
});

describe('useTerminal: input, resize and unmount', () => {
  it('typed input reaches bridge.write', async () => {
    const { bridge, running } = mount();
    await running();
    Terminal.last().type('ls\r');
    expect(bridge.writes).toEqual([{ chatId: CHAT, data: 'ls\r' }]);
  });

  it('a resize reaches bridge.resize, after the fit is debounced', async () => {
    const { bridge, running } = mount();
    await running();
    FitAddon.size = { cols: 100, rows: 30 };
    const fitsBefore = FitAddon.fits;
    FakeResizeObserver.instances.at(-1)?.trigger();
    expect(FitAddon.fits).toBe(fitsBefore);

    await waitFor(() => expect(bridge.resizes.at(-1)).toEqual({ chatId: CHAT, cols: 100, rows: 30 }));
    expect(Terminal.last()).toMatchObject({ cols: 100, rows: 30 });
  });

  it('after the shell exits, input and resizes are not sent until a restart', async () => {
    const { bridge, into, running } = mount();
    await running();
    act(() => bridge.emitExit(CHAT, { state: 'exited', exitCode: 0, signal: null }));
    expect(into.current?.phase).toBe('exited');

    Terminal.last().type('echo late\r');
    FitAddon.size = { cols: 120, rows: 40 };
    FakeResizeObserver.instances.at(-1)?.trigger();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bridge.writes).toEqual([]);
    expect(bridge.resizes.some((r) => r.cols === 120)).toBe(false);
  });

  it('unmounting disposes xterm and does not close the session', async () => {
    const { bridge, running, unmount } = mount();
    await running();
    const term = Terminal.last();
    unmount();
    expect(term.disposed).toBe(true);
    expect(bridge.closes).toEqual([]);
    expect(bridge.hasSession(CHAT)).toBe(true);
  });
});
