// The preload bridge (docs/terminal-plan.md T1.5). Electron is mocked so the sandboxed preload module can run in Node.
// It lives under src/main because that is the closest directory the node Vitest project includes; it imports across to
// src/preload, which is the module under test.

import { TERMINAL_IPC, type TerminalBridge } from '@shared/terminal';
import { describe, expect, it, vi } from 'vitest';
import { PRELOAD_TERMINAL_IPC } from '../../preload/index';

const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, payload: unknown) => void;
  const listeners = new Map<string, Set<Handler>>();
  const dispatch = (channel: string, payload: unknown): void => {
    for (const handler of [...(listeners.get(channel) ?? [])]) handler({ sender: 'test' }, payload);
  };
  // A plain record, not a mock: vi.fn call history is cleared before the tests run, so the expose call made while
  // the preload is imported would be lost.
  const exposed: Array<{ key: string; api: unknown }> = [];
  return {
    exposed,
    dispatch,
    ipcRenderer: {
      invoke: vi.fn(async (_channel: string, ..._args: unknown[]): Promise<unknown> => undefined),
      send: vi.fn((_channel: string, ..._args: unknown[]): void => {}),
      on: vi.fn((channel: string, handler: Handler): void => {
        const set = listeners.get(channel) ?? new Set<Handler>();
        set.add(handler);
        listeners.set(channel, set);
      }),
      removeListener: vi.fn((channel: string, handler: Handler): void => {
        listeners.get(channel)?.delete(handler);
      }),
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown): void => {
      mocks.exposed.push({ key, api });
    },
  },
  ipcRenderer: mocks.ipcRenderer,
}));

interface ExposedBridge {
  isElectron: boolean;
  terminal: TerminalBridge;
}

function bridge(): ExposedBridge {
  const call = mocks.exposed[0];
  if (!call) throw new Error('the preload did not expose window.openvern');
  return call.api as ExposedBridge;
}

describe('PRELOAD_TERMINAL_IPC', () => {
  it('matches TERMINAL_IPC, key for key and channel for channel', () => {
    expect(PRELOAD_TERMINAL_IPC).toStrictEqual(TERMINAL_IPC);
    expect(Object.keys(PRELOAD_TERMINAL_IPC).sort()).toStrictEqual(Object.keys(TERMINAL_IPC).sort());
  });
});

describe('the exposed terminal bridge', () => {
  it('exposes the bridge on window.openvern', () => {
    expect(mocks.exposed).toHaveLength(1);
    expect(mocks.exposed[0]?.key).toBe('openvern');
    const exposed = bridge();
    expect(exposed.isElectron).toBe(true);
    expect(exposed.terminal).toBeTypeOf('object');
    for (const method of ['open', 'list', 'write', 'resize', 'close', 'adopt', 'onData', 'onExit'] as const) {
      expect(typeof exposed.terminal[method]).toBe('function');
    }
    // Fixed methods only: nothing that hands out ipcRenderer or a way to name a channel.
    expect(Object.keys(exposed.terminal).sort()).toStrictEqual(
      ['adopt', 'close', 'list', 'onData', 'onExit', 'open', 'resize', 'write'].sort(),
    );
    expect(Object.keys(exposed).sort()).toStrictEqual(['isElectron', 'pickDirectory', 'terminal']);
  });

  it('forwards each call over the documented channel with only its arguments', async () => {
    const { terminal } = bridge();
    const request = { chatId: 'chat-1', cwd: null, cols: 80, rows: 24 };

    await terminal.open(request);
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(TERMINAL_IPC.open, request);

    terminal.write('chat-1', 'ls\r');
    expect(mocks.ipcRenderer.send).toHaveBeenCalledWith(TERMINAL_IPC.write, 'chat-1', 'ls\r');

    terminal.resize('chat-1', 100, 30);
    expect(mocks.ipcRenderer.send).toHaveBeenCalledWith(TERMINAL_IPC.resize, 'chat-1', 100, 30);

    await terminal.list();
    expect(mocks.ipcRenderer.invoke).toHaveBeenLastCalledWith(TERMINAL_IPC.list);

    await terminal.close('chat-1');
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(TERMINAL_IPC.close, 'chat-1');

    mocks.ipcRenderer.invoke.mockResolvedValueOnce(true);
    await expect(terminal.adopt('__draft__', 'chat-1')).resolves.toBe(true);
    // Exactly the two ids: nothing else rides along.
    expect(mocks.ipcRenderer.invoke.mock.lastCall).toStrictEqual([TERMINAL_IPC.adopt, '__draft__', 'chat-1']);
  });

  it('passes only the payload to onData listeners and unsubscribes them', () => {
    const { terminal } = bridge();
    const listener = vi.fn();
    const before = mocks.ipcRenderer.on.mock.calls.length;
    const unsubscribe = terminal.onData(listener);
    const handler = mocks.ipcRenderer.on.mock.calls[before]?.[1];
    expect(handler).toBeTypeOf('function');
    expect(mocks.ipcRenderer.on).toHaveBeenLastCalledWith(TERMINAL_IPC.data, handler);

    const payload = { chatId: 'chat-1', seq: 7, data: 'hello' };
    mocks.dispatch(TERMINAL_IPC.data, payload);
    expect(listener).toHaveBeenCalledTimes(1);
    // One argument, the payload: never the IPC event.
    expect(listener.mock.calls[0]).toStrictEqual([payload]);

    unsubscribe();
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith(TERMINAL_IPC.data, handler);
    mocks.dispatch(TERMINAL_IPC.data, payload);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('passes only the payload to onExit listeners and unsubscribes them', () => {
    const { terminal } = bridge();
    const listener = vi.fn();
    const before = mocks.ipcRenderer.on.mock.calls.length;
    const unsubscribe = terminal.onExit(listener);
    const handler = mocks.ipcRenderer.on.mock.calls[before]?.[1];
    expect(handler).toBeTypeOf('function');
    expect(mocks.ipcRenderer.on).toHaveBeenLastCalledWith(TERMINAL_IPC.exit, handler);

    const payload = { chatId: 'chat-1', status: { state: 'exited', exitCode: 1, signal: null } };
    mocks.dispatch(TERMINAL_IPC.exit, payload);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]).toStrictEqual([payload]);

    unsubscribe();
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith(TERMINAL_IPC.exit, handler);
    mocks.dispatch(TERMINAL_IPC.exit, payload);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps data and exit listeners apart', () => {
    const { terminal } = bridge();
    const onData = vi.fn();
    const onExit = vi.fn();
    const offData = terminal.onData(onData);
    const offExit = terminal.onExit(onExit);
    try {
      mocks.dispatch(TERMINAL_IPC.data, { chatId: 'chat-1', seq: 1, data: 'x' });
      expect(onData).toHaveBeenCalledTimes(1);
      expect(onExit).not.toHaveBeenCalled();

      mocks.dispatch(TERMINAL_IPC.exit, { chatId: 'chat-1', status: { state: 'running' } });
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onData).toHaveBeenCalledTimes(1);
    } finally {
      offData();
      offExit();
    }
  });
});
