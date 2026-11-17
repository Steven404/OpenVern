import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalRegistry } from './registry';

// xterm cannot draw in jsdom: the terminal and its fit addon are recording fakes (see `test-fakes.ts`).
vi.mock('@xterm/xterm', () => import('./test-fakes'));
vi.mock('@xterm/addon-fit', () => import('./test-fakes'));

import { TERMINAL } from '@shared/terminal';
import { FakeTerminalBridge, FitAddon, resetTerminalFakes, Terminal } from './test-fakes';
import { splitTerminalWrite, type TerminalHandle, terminalErrorMessage, useTerminal } from './use-terminal';

const CHAT = 'chat-1';
const bytes = (text: string) => new TextEncoder().encode(text).length;

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
  terminalRegistry.disposeAll();
  resetTerminalFakes();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240);
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

  it('attaching writes the replay once, then ignores events at or below its sequence number', async () => {
    const bridge = new FakeTerminalBridge();
    bridge.seed(CHAT, { replay: 'SNAPSHOT', seq: 5 });
    const { running } = mount(bridge);
    await running();
    expect(Terminal.last().writes).toEqual(['SNAPSHOT']);

    bridge.emitData(CHAT, 'same', 5);
    bridge.emitData(CHAT, 'older', 3);
    expect(Terminal.last().writes).toEqual(['SNAPSHOT']);

    bridge.emitData(CHAT, 'fresh', 6);
    expect(Terminal.last().writes).toEqual(['SNAPSHOT', 'fresh']);
  });

  it('events that arrive before open resolves are kept only above the replay, and written in order', async () => {
    const bridge = new FakeTerminalBridge();
    bridge.seed(CHAT, { replay: 'SNAPSHOT', seq: 5 });
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

  it('attaches to an exited session: its replay and status show, and input never reaches it', async () => {
    const bridge = new FakeTerminalBridge();
    bridge.seed(CHAT, { replay: 'RESTORED OUTPUT', seq: 3 });
    bridge.emitExit(CHAT, { state: 'exited', exitCode: 1, signal: null });

    const { into } = mount(bridge);
    await waitFor(() => expect(into.current?.phase).toBe('exited'));
    expect(bridge.opens[0]).not.toHaveProperty('restart', true);
    expect(Terminal.last().writes).toEqual(['RESTORED OUTPUT']);
    expect(into.current?.info?.status).toEqual({ state: 'exited', exitCode: 1, signal: null });

    Terminal.last().type('echo late\r');
    expect(bridge.writes).toEqual([]);
  });

  it('an exit seen while open is in flight wins over the reply, and the session is never ready for input', async () => {
    const bridge = new FakeTerminalBridge();
    const release = bridge.holdOpens();
    const { into } = mount(bridge);

    act(() => bridge.emitExit(CHAT, { state: 'exited', exitCode: 2, signal: null }));
    release();
    await waitFor(() => expect(bridge.opens).toHaveLength(1));
    await waitFor(() => expect(into.current?.info?.status).toEqual({ state: 'exited', exitCode: 2, signal: null }));
    expect(into.current?.phase).toBe('exited');

    Terminal.last().type('echo late\r');
    expect(bridge.writes).toEqual([]);
  });

  it('strips the Electron IPC wrapper from an open failure', async () => {
    const bridge = new FakeTerminalBridge();
    bridge.open = async () => {
      throw new Error(
        "Error invoking remote method 'openvern:terminal:open': Error: At most 8 terminals can run at once. End one to open another.",
      );
    };
    const { into } = mount(bridge);
    await waitFor(() => expect(into.current?.phase).toBe('error'));
    expect(into.current?.error).toBe('At most 8 terminals can run at once. End one to open another.');
  });

  it('reads the per-run shell limit naturally too', async () => {
    const bridge = new FakeTerminalBridge();
    bridge.open = async () => {
      throw new Error(
        "Error invoking remote method 'openvern:terminal:open': Error: OpenVern has started its limit of 100 shells in this run. Reopen the app to start another.",
      );
    };
    const { into } = mount(bridge);
    await waitFor(() => expect(into.current?.phase).toBe('error'));
    expect(into.current?.error).toBe(
      'OpenVern has started its limit of 100 shells in this run. Reopen the app to start another.',
    );
  });
});

describe('terminalErrorMessage', () => {
  it('keeps a plain message as it is', () => {
    expect(terminalErrorMessage(new Error('The folder is not available.'))).toBe('The folder is not available.');
  });

  it('falls back for an empty error or a non-Error value', () => {
    expect(terminalErrorMessage(new Error('   '))).toBe("Couldn't open the terminal.");
    expect(terminalErrorMessage('nope')).toBe("Couldn't open the terminal.");
  });

  it('removes repeated wrappers', () => {
    expect(
      terminalErrorMessage(
        new Error("Error invoking remote method 'openvern:terminal:open': Error: Error: One message."),
      ),
    ).toBe('One message.');
  });
});

describe('useTerminal: input, resize and unmount', () => {
  it('typed input reaches bridge.write', async () => {
    const { bridge, running } = mount();
    await running();
    Terminal.last().type('ls\r');
    expect(bridge.writes).toEqual([{ chatId: CHAT, data: 'ls\r' }]);
  });

  it('a large paste is split into ordered pieces of at most writeMaxBytes, without cutting a character', async () => {
    const { bridge, running } = mount();
    await running();
    const paste = `${'a'.repeat(TERMINAL.writeMaxBytes - 1)}é${'🙂'.repeat(20)}${'b'.repeat(TERMINAL.writeMaxBytes)}`;
    Terminal.last().type(paste);

    expect(bridge.writes.length).toBeGreaterThan(1);
    expect(bridge.writes.map((write) => write.data).join('')).toBe(paste);
    for (const write of bridge.writes) expect(bytes(write.data)).toBeLessThanOrEqual(TERMINAL.writeMaxBytes);
    // The character that straddled the first boundary survived whole, at the start of the next piece.
    expect(bridge.writes[1]?.data.startsWith('é')).toBe(true);
    for (const write of bridge.writes) expect(write.data).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('splitTerminalWrite keeps surrogate pairs and multi-byte characters whole', () => {
    expect(splitTerminalWrite('', 4)).toEqual([]);
    expect(splitTerminalWrite('abcdef', 4)).toEqual(['abcd', 'ef']);
    expect(splitTerminalWrite('😀😀', 4)).toEqual(['😀', '😀']);
    // é is 2 bytes: a 3-byte budget leaves no room for a second one.
    expect(splitTerminalWrite('aéé', 3)).toEqual(['aé', 'é']);
    for (const piece of splitTerminalWrite(`${'x'.repeat(50)}🙂`, 7)) {
      expect(bytes(piece)).toBeLessThanOrEqual(7);
      expect(piece).not.toMatch(/[\uD800-\uDBFF]$/);
    }
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

  it('fits again once the mono font has loaded, and tells main the new size', async () => {
    const original = Object.getOwnPropertyDescriptor(document, 'fonts');
    let resolveFont: () => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveFont = () => resolve([]);
        }),
    );
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load } });
    try {
      const { bridge, running } = mount();
      await running();
      expect(load).toHaveBeenCalled();

      FitAddon.size = { cols: 90, rows: 30 };
      const fitsBefore = FitAddon.fits;
      resolveFont();
      await waitFor(() => expect(FitAddon.fits).toBeGreaterThan(fitsBefore));
      await waitFor(() => expect(bridge.resizes.at(-1)).toEqual({ chatId: CHAT, cols: 90, rows: 30 }));
    } finally {
      if (original) Object.defineProperty(document, 'fonts', original);
      else Reflect.deleteProperty(document, 'fonts');
    }
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

  it('restart asks main to replace the exited shell and focuses the new terminal', async () => {
    const { bridge, into, running } = mount();
    await running();
    act(() => bridge.emitExit(CHAT, { state: 'exited', exitCode: 0, signal: null }));

    act(() => into.current?.restart());
    await waitFor(() => expect(bridge.opens).toHaveLength(2));
    expect(bridge.opens[1]).toMatchObject({ chatId: CHAT, restart: true });
    await running();
    expect(document.activeElement).toBe(Terminal.last().textarea);
    expect(bridge.closes).toEqual([]);
  });

  it('retry opens again without asking main to replace a session', async () => {
    const bridge = new FakeTerminalBridge();
    const open = bridge.open.bind(bridge);
    let fail = true;
    bridge.open = async (request) => {
      if (fail) {
        fail = false;
        throw new Error('Temporarily unavailable.');
      }
      return open(request);
    };
    const { into } = mount(bridge);
    await waitFor(() => expect(into.current?.phase).toBe('error'));

    act(() => into.current?.retry());
    await waitFor(() => expect(into.current?.phase).toBe('running'));
    expect(bridge.opens[0]).not.toHaveProperty('restart', true);
  });

  it('unmounting preserves xterm and does not close the session', async () => {
    const { bridge, running, unmount } = mount();
    await running();
    const term = Terminal.last();
    unmount();
    expect(term.disposed).toBe(false);
    expect(bridge.closes).toEqual([]);
    expect(bridge.hasSession(CHAT)).toBe(true);
  });
});

/** The dock for one project's folder: `onCreated` records that project, as the New Chat dock does. */
function Folder({
  cwd,
  onCreated,
  bridge,
  into,
}: {
  cwd: string;
  onCreated: () => void;
  bridge: FakeTerminalBridge;
  into: { current: TerminalHandle | null };
}) {
  const terminal = useTerminal(CHAT, { cwd, onCreated, bridge });
  into.current = terminal;
  return <div ref={terminal.containerRef} />;
}

describe('useTerminal: the shell a new callback claims', () => {
  it('reports a new shell to the callback rendered with the folder it started in, not a later one', async () => {
    const bridge = new FakeTerminalBridge();
    const into: { current: TerminalHandle | null } = { current: null };
    const created: string[] = [];
    const release = bridge.holdOpens();
    const view = render(<Folder cwd="/a" onCreated={() => created.push('a')} bridge={bridge} into={into} />);
    // The project changes while the shell started in /a is still opening.
    view.rerender(<Folder cwd="/b" onCreated={() => created.push('b')} bridge={bridge} into={into} />);
    release();
    await waitFor(() => expect(into.current?.phase).toBe('running'));

    expect(bridge.opens.map((open) => open.cwd)).toEqual(['/a']);
    expect(created).toEqual(['a']);
  });
});
