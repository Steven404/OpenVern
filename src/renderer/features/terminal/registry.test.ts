import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => import('./test-fakes'));
vi.mock('@xterm/addon-fit', () => import('./test-fakes'));

import { TERMINAL } from '@shared/terminal';
import { TerminalRegistry } from './registry';
import { FakeTerminalBridge, resetTerminalFakes, Terminal } from './test-fakes';

let registry: TerminalRegistry;
let bridge: FakeTerminalBridge;
beforeEach(() => {
  registry = new TerminalRegistry();
  bridge = new FakeTerminalBridge();
  resetTerminalFakes();
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
    await expect(registry.attach('extra', bridge, { cwd: null })).rejects.toThrow('Too many');
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
    await expect(read).rejects.toThrow('sessions changed');
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
