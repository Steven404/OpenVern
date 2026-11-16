import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => import('./test-fakes'));
vi.mock('@xterm/addon-fit', () => import('./test-fakes'));

import { TERMINAL } from '@shared/terminal';
import {
  TERMINAL_PASTE_TOO_LARGE,
  TERMINAL_RESYNC_PAUSE_MS,
  TERMINAL_SKIPPED_OUTPUT,
  TerminalRegistry,
} from './registry';
import { FakeTerminalBridge, FitAddon, resetTerminalFakes, Terminal } from './test-fakes';

let registry: TerminalRegistry;
let bridge: FakeTerminalBridge;
beforeEach(() => {
  registry = new TerminalRegistry();
  bridge = new FakeTerminalBridge();
  resetTerminalFakes();
});
afterEach(() => {
  registry.disposeAll();
  vi.useRealTimers();
});
describe('terminal emulator registry', () => {
  it('shares one instance and one in-flight attach per chat, with no replay into a live instance', async () => {
    bridge.seed('a', { replay: 'original', seq: 3 });
    const [a, b] = await Promise.all([
      registry.attach('a', bridge, { cwd: null }),
      registry.attach('a', bridge, { cwd: null }),
    ]);
    expect(a).toBe(b);
    const detach = a.mount(document.createElement('div'));
    detach();
    bridge.emitData('a', 'hidden output', 4);
    await registry.attach('b', bridge, { cwd: null });
    expect(await registry.attach('a', bridge, { cwd: null })).toBe(a);
    expect(bridge.opens.filter((o) => o.chatId === 'a')).toHaveLength(1);
    expect(a.term).toMatchObject({ disposed: false, writes: ['original', 'hidden output'] });
    registry.dispose('a');
    expect(a.term).toMatchObject({ disposed: true });
  });
  it('enforces the instance cap, including pending attaches', async () => {
    for (let i = 0; i < TERMINAL.maxSessions; i++) await registry.attach(`${i}`, bridge, { cwd: null });
    await expect(registry.attach('extra', bridge, { cwd: null })).rejects.toThrow(
      'At most 8 terminals can run at once, counting any that are still closing. End one to open another.',
    );
    registry.dispose('0');
    await expect(registry.attach('extra', bridge, { cwd: null })).resolves.toBeDefined();
    registry.disposeAll();
  });
  it('suppresses replay query responses until parsing completes and drains ordered events once', async () => {
    bridge.seed('a', { replay: 'replay', seq: 3 });
    const release = bridge.holdOpens();
    const attached = registry.attach('a', bridge, { cwd: null });
    const term = Terminal.last();
    const write = term.write.bind(term);
    let finish: () => void = () => {};
    term.write = (data, callback) => {
      write(data);
      term.type('query-response');
      if (data === 'replay') finish = () => callback?.();
      else callback?.();
    };
    bridge.emitData('a', 'five', 5);
    bridge.emitData('a', 'four', 4);
    bridge.emitData('a', 'duplicate', 4);
    bridge.emitData('a', 'old', 3);
    release();
    await vi.waitFor(() => expect(term.writes).toEqual(['replay']));
    term.type('user input during replay');
    expect(bridge.writes).toEqual([]);
    bridge.emitData('a', 'six', 6);
    finish();
    await attached;
    expect(term.writes).toEqual(['replay', 'four', 'five', 'six']);
    bridge.writes.length = 0;
    term.type('after');
    expect(bridge.writes).toEqual([{ chatId: 'a', data: 'after' }]);
    bridge.emitData('a', 'duplicate', 6);
    expect(term.writes).toHaveLength(4);
  });
  it('attaches on a read after reload using list dimensions, or reports no terminal', async () => {
    expect(await registry.read('absent', bridge, {})).toEqual({ ok: false, reason: 'no_terminal' });
    bridge.seed('a', { replay: 'restored' });
    const list = bridge.list.bind(bridge);
    bridge.list = async () => (await list()).map((info) => ({ ...info, cols: 42, rows: 11 }));
    const result = await registry.read('a', bridge, {});
    expect(bridge.opens[0]).toMatchObject({ cols: 42, rows: 11 });
    expect(result).toMatchObject({ ok: true, result: { text: 'restored' } });
    bridge.list = async () => {
      throw new Error('should not list a live instance');
    };
    expect(await registry.read('a', bridge, {})).toMatchObject({ ok: true });
  });
  it('does not resurrect a session ended while a reload read was listing sessions', async () => {
    bridge.seed('a');
    const sessions = await bridge.list();
    let release: (value: typeof sessions) => void = () => {};
    bridge.list = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const read = registry.read('a', bridge, {});
    registry.dispose('a');
    await bridge.close('a');
    release(sessions);
    expect(await read).toEqual({ ok: false, reason: 'no_terminal' });
    expect(bridge.opens).toEqual([]);
  });
  it('waits for queued output to parse before reading', async () => {
    const entry = await registry.attach('a', bridge, { cwd: null });
    const term = Terminal.last();
    const write = term.write.bind(term);
    let flush: () => void = () => {};
    term.write = (data, callback) => {
      if (callback) flush = callback;
      else write(data);
    };
    bridge.emitData('a', 'latest');
    let settled = false;
    const reading = registry.read('a', bridge, {}).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    flush();
    expect(await reading).toMatchObject({ ok: true, result: { text: 'latest', info: entry.info } });
  });
});

it('closes an accidental shell created between a read list and attach', async () => {
  bridge.seed('a');
  const list = bridge.list.bind(bridge);
  bridge.list = async () => {
    const infos = await list();
    await bridge.close('a');
    return infos;
  };
  expect(await registry.read('a', bridge, {})).toEqual({ ok: false, reason: 'no_terminal' });
  expect(bridge.closes).toEqual(['a', 'a']);
  expect(registry.get('a')).toBeUndefined();
  expect(Terminal.last().disposed).toBe(true);
});

it('reconciles missing main sessions at capacity and evicts the oldest exited entry', async () => {
  for (let i = 0; i < TERMINAL.maxSessions; i++) await registry.attach(`${i}`, bridge, { cwd: null });
  await bridge.close('0');
  await registry.attach('extra', bridge, { cwd: null });
  expect(registry.get('0')).toBeUndefined();
  bridge.emitExit('1', { state: 'exited', exitCode: 0, signal: null });
  bridge.emitExit('2', { state: 'exited', exitCode: 0, signal: null });
  await registry.attach('next', bridge, { cwd: null });
  expect(registry.get('1')).toBeUndefined();
  expect(registry.get('2')).toBeDefined();
});

it('confirms an exited entry with main before returning its buffer', async () => {
  await registry.attach('a', bridge, { cwd: null });
  bridge.emitExit('a', { state: 'exited', exitCode: 0, signal: null });
  expect(await registry.read('a', bridge, {})).toMatchObject({ ok: true });
  await bridge.close('a');
  expect(await registry.read('a', bridge, {})).toEqual({ ok: false, reason: 'no_terminal' });
  expect(registry.get('a')).toBeUndefined();
});

it('resynchronises after a listener overflow and resumes output above the replay sequence', async () => {
  const entry = await registry.attach('a', bridge, { cwd: null });
  const write = vi.spyOn(entry.term, 'write').mockImplementation(() => {
    throw new Error('write buffer exceeded');
  });
  expect(() => bridge.emitData('a', 'lost', 1)).not.toThrow();
  write.mockRestore();
  const release = bridge.holdOpens();
  expect(await registry.read('a', bridge, {})).toEqual({ ok: false, reason: 'unavailable' });
  await vi.waitFor(() => expect(bridge.opens).toHaveLength(2));
  bridge.emitData('a', 'later', 2);
  release();
  await vi.waitFor(() => expect(entry.notice).toBeNull());
  expect(await registry.read('a', bridge, {})).toMatchObject({ ok: true });
  expect(Terminal.last().writes).toEqual(['lost', `\r\n${TERMINAL_SKIPPED_OUTPUT}\r\n`, 'later']);
  bridge.emitData('a', 'duplicate', 2);
  bridge.emitData('a', 'after', 3);
  expect(Terminal.last().writes.at(-1)).toBe('after');
});

it('recovers a parse barrier throw instead of permanently failing reads', async () => {
  const entry = await registry.attach('a', bridge, { cwd: null });
  const write = vi.spyOn(entry.term, 'write').mockImplementation(() => {
    throw new Error('write buffer exceeded');
  });
  expect(await registry.read('a', bridge, {})).toEqual({ ok: false, reason: 'unavailable' });
  write.mockRestore();
  await vi.waitFor(() => expect(entry.notice).toBeNull());
  expect(await registry.read('a', bridge, {})).toMatchObject({ ok: true });
});

it('answers no_terminal when End happens while waiting for parsing', async () => {
  const entry = await registry.attach('a', bridge, { cwd: null });
  vi.spyOn(entry.term, 'write').mockImplementation(() => {});
  const read = registry.read('a', bridge, {});
  await Promise.resolve();
  registry.dispose('a');
  expect(await read).toEqual({ ok: false, reason: 'no_terminal' });
});

it('does not let disposal of another chat invalidate a read during list', async () => {
  bridge.seed('a', { replay: 'safe' });
  const list = bridge.list.bind(bridge);
  bridge.list = async () => {
    registry.dispose('unrelated');
    return list();
  };
  expect(await registry.read('a', bridge, {})).toMatchObject({ ok: true, result: { text: 'safe' } });
});

it('rejects invalid requests before list or open', async () => {
  const list = vi.spyOn(bridge, 'list');
  for (const value of [0, -1, 1.2, NaN, Infinity]) {
    for (const request of [{ count: value }, { startLine: value }]) {
      expect(await registry.read('a', bridge, request)).toEqual({ ok: false, reason: 'unavailable' });
    }
  }
  expect(list).not.toHaveBeenCalled();
  expect(bridge.opens).toEqual([]);
});

it('opens at clamped fitted dimensions and skips fitting a zero-size host', async () => {
  const host = document.createElement('div');
  Object.defineProperties(host, {
    clientWidth: { value: 800, configurable: true },
    clientHeight: { value: 240, configurable: true },
  });
  FitAddon.size = { cols: 1000, rows: 1 };
  const entry = await registry.attach('a', bridge, { cwd: null, host });
  expect(bridge.opens[0]).toMatchObject({ cols: 500, rows: 5 });
  expect(entry.info).toMatchObject({ cols: 500, rows: 5 });
  FitAddon.size = { cols: 1, rows: 1000 };
  const detach = entry.mount(host);
  expect(entry.info).toMatchObject({ cols: 20, rows: 200 });
  detach();
  Object.defineProperty(host, 'clientWidth', { value: 0 });
  FitAddon.size = { cols: 99, rows: 99 };
  const unmount = entry.mount(host);
  expect(entry.info).toMatchObject({ cols: 20, rows: 200 });
  unmount();
});

it('throttles sustained overflow to one recovery attempt at a time and cancels on End', async () => {
  vi.useFakeTimers();
  const entry = await registry.attach('a', bridge, { cwd: null });
  const write = vi.spyOn(entry.term, 'write').mockImplementation(() => {
    throw new Error('overflow');
  });
  bridge.emitData('a', 'lost');
  await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_PAUSE_MS - 1);
  expect(write).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(write).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 100; i++) bridge.emitData('a', 'flood');
  expect(write).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_PAUSE_MS);
  expect(write).toHaveBeenCalledTimes(3);
  registry.dispose('a');
  await vi.advanceTimersByTimeAsync(1000);
  expect(write).toHaveBeenCalledTimes(3);
});

it('bounds events received during a recovery replay and retries from a newer snapshot', async () => {
  vi.useFakeTimers();
  const entry = await registry.attach('a', bridge, { cwd: null });
  vi.spyOn(entry.term, 'write').mockImplementationOnce(() => {
    throw new Error('overflow');
  });
  bridge.emitData('a', 'lost');
  const release = bridge.holdOpens();
  await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_PAUSE_MS);
  expect(bridge.opens).toHaveLength(2);
  bridge.emitData('a', 'x'.repeat(TERMINAL.replayMaxBytes + 1));
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(await registry.read('a', bridge, {})).toEqual({ ok: false, reason: 'unavailable' });
  await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_PAUSE_MS);
  expect(bridge.opens).toHaveLength(3);
  expect(entry.notice).toBeNull();
  expect(await registry.read('a', bridge, {})).toMatchObject({ ok: true });
});

it('refuses an oversized bracketed paste atomically, counting UTF-8 bytes, with a dock-only notice', async () => {
  await registry.attach('a', bridge, { cwd: null });
  const term = Terminal.last();
  const before = [...term.writes];
  term.type(`\x1b[200~${'é'.repeat(TERMINAL.pendingInputMaxBytes / 2)}\x1b[201~`);
  expect(bridge.writes).toEqual([]);
  expect(term.writes).toEqual(before);
  expect(registry.get('a')?.notice).toBe(TERMINAL_PASTE_TOO_LARGE);
  term.type('x'.repeat(TERMINAL.pendingInputMaxBytes));
  expect(bridge.writes.map((piece) => piece.data).join('')).toBe('x'.repeat(TERMINAL.pendingInputMaxBytes));
  expect(registry.get('a')?.notice).toBeNull();
});

it('retries a failed recovery attach, and never replays a reply arriving after End', async () => {
  vi.useFakeTimers();
  const entry = await registry.attach('a', bridge, { cwd: null });
  vi.spyOn(entry.term, 'write').mockImplementationOnce(() => {
    throw new Error('overflow');
  });
  const open = vi.spyOn(bridge, 'open').mockRejectedValueOnce(new Error('temporarily unavailable'));
  bridge.emitData('a', 'lost');
  await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_PAUSE_MS);
  expect(open).toHaveBeenCalledTimes(1);
  const release = bridge.holdOpens();
  await vi.advanceTimersByTimeAsync(TERMINAL_RESYNC_PAUSE_MS);
  expect(open).toHaveBeenCalledTimes(2);
  registry.dispose('a');
  const writes = [...Terminal.last().writes];
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(Terminal.last().writes).toEqual(writes);
  expect(open).toHaveBeenCalledTimes(2);
});

describe('renaming the draft terminal to its chat', () => {
  it('keeps the same emulator and draws events that carry the new id, not the old one', async () => {
    const entry = await registry.attach('__draft__', bridge, { cwd: null, defaultFolder: 'documents' });
    expect(bridge.opens[0]).toMatchObject({ chatId: '__draft__', cwd: null, defaultFolder: 'documents' });
    bridge.emitData('__draft__', 'before ');
    expect(await bridge.adopt('__draft__', 'chat-1')).toBe(true);
    expect(registry.rename('__draft__', 'chat-1')).toBe(true);

    expect(entry.id).toBe('chat-1');
    expect(entry.info.chatId).toBe('chat-1');
    expect(registry.get('chat-1')).toBe(entry);
    expect(registry.get('__draft__')).toBeUndefined();
    bridge.emitData('chat-1', 'after', 2);
    bridge.emitData('__draft__', 'stray', 3);
    expect(Terminal.last().writes).toEqual(['before ', 'after']);
    bridge.emitExit('chat-1', { state: 'exited', exitCode: 0, signal: null });
    expect(entry.info.status.state).toBe('exited');
    // Attaching under the chat id reuses it: no second open, no second emulator.
    expect(await registry.attach('chat-1', bridge, { cwd: null })).toBe(entry);
    expect(bridge.opens).toHaveLength(1);
    expect(Terminal.instances).toHaveLength(1);
  });

  it('sends typing and resizes under the new id', async () => {
    await registry.attach('__draft__', bridge, { cwd: '/project' });
    await bridge.adopt('__draft__', 'chat-1');
    registry.rename('__draft__', 'chat-1');
    Terminal.last().type('ls\r');
    Terminal.last().resize(100, 30);
    expect(bridge.writes).toEqual([{ chatId: 'chat-1', data: 'ls\r' }]);
    expect(bridge.resizes).toEqual([{ chatId: 'chat-1', cols: 100, rows: 30 }]);
  });

  it('answers a read under the new id, and none under the old one', async () => {
    await registry.attach('__draft__', bridge, { cwd: null });
    bridge.emitData('__draft__', 'pre-chat-41');
    await bridge.adopt('__draft__', 'chat-1');
    registry.rename('__draft__', 'chat-1');
    expect(await registry.read('chat-1', bridge, {})).toMatchObject({
      ok: true,
      result: { text: 'pre-chat-41', info: { chatId: 'chat-1' } },
    });
    expect(await registry.read('__draft__', bridge, {})).toEqual({ ok: false, reason: 'no_terminal' });
  });

  it('does nothing when there is no emulator to move', () => {
    expect(registry.rename('__draft__', 'chat-1')).toBe(false);
    expect(registry.get('chat-1')).toBeUndefined();
  });

  it('reports onCreated only for an attach that started a new shell', async () => {
    const created: string[] = [];
    await registry.attach('a', bridge, { cwd: null, onCreated: () => created.push('a') });
    bridge.seed('b');
    await registry.attach('b', bridge, { cwd: null, onCreated: () => created.push('b') });
    await registry.attach('a', bridge, { cwd: null, onCreated: () => created.push('a again') });
    expect(created).toEqual(['a']);
  });
});
