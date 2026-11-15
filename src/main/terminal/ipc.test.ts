// The IPC boundary (docs/terminal-plan.md T1.5): every inbound channel checks the sender first, then the payload, and
// nothing here may throw out of a `send` listener in main. A page that isn't the app's main-window page must never
// reach the manager.

import {
  TERMINAL,
  TERMINAL_IPC,
  type TerminalInfo,
  type TerminalOpenResult,
  type TerminalReadAnswer,
  type TerminalReadRequest,
} from '@shared/terminal';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { INVALID_REQUEST, registerTerminalIpc, type TerminalIpcMain, UNTRUSTED_SENDER } from './ipc';
import type { OpenParams } from './manager';

const INFO: TerminalInfo = {
  chatId: 'chat-1',
  shell: 'zsh',
  cwd: '/home/me',
  cols: 80,
  rows: 24,
  status: { state: 'running' },
};
const OPEN_RESULT: TerminalOpenResult = { info: INFO, snapshot: '', seq: 0, created: true };
const READ_ANSWER: TerminalReadAnswer = {
  ok: true,
  result: { info: INFO, totalLines: 1, startLine: 1, endLine: 1, text: 'x', truncated: false },
};

interface FakeManager {
  open: Mock<(params: OpenParams) => Promise<TerminalOpenResult>>;
  read: Mock<(chatId: string, request: TerminalReadRequest) => Promise<TerminalReadAnswer>>;
  close: Mock<(chatId: string) => Promise<void>>;
  write: Mock<(chatId: string, data: string) => void>;
  resize: Mock<(chatId: string, cols: number, rows: number) => void>;
}

function createManager(): FakeManager {
  return {
    open: vi.fn(async (_params: OpenParams): Promise<TerminalOpenResult> => OPEN_RESULT),
    read: vi.fn(async (_chatId: string, _request: TerminalReadRequest): Promise<TerminalReadAnswer> => READ_ANSWER),
    close: vi.fn(async (_chatId: string): Promise<void> => {}),
    write: vi.fn((_chatId: string, _data: string): void => {}),
    resize: vi.fn((_chatId: string, _cols: number, _rows: number): void => {}),
  };
}

type Handler = (event: unknown, ...args: unknown[]) => unknown;
type Listener = (event: unknown, ...args: unknown[]) => void;

interface FakeIpc {
  readonly ipc: TerminalIpcMain;
  readonly handled: Map<string, Handler>;
  readonly listened: Map<string, Listener>;
  invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown>;
  send(channel: string, event: unknown, ...args: unknown[]): void;
}

function createFakeIpc(): FakeIpc {
  const handled = new Map<string, Handler>();
  const listened = new Map<string, Listener>();
  const required = <T>(map: Map<string, T>, channel: string): T => {
    const found = map.get(channel);
    if (!found) throw new Error(`nothing registered for ${channel}`);
    return found;
  };
  return {
    handled,
    listened,
    ipc: {
      handle(channel, listener) {
        handled.set(channel, (event, ...args) => listener(event as IpcMainInvokeEvent, ...args));
      },
      on(channel, listener) {
        listened.set(channel, (event, ...args) => listener(event as IpcMainEvent, ...args));
      },
    },
    async invoke(channel, event, ...args) {
      return await required(handled, channel)(event, ...args);
    },
    send(channel, event, ...args) {
      required(listened, channel)(event, ...args);
    },
  };
}

interface Setup {
  readonly manager: FakeManager;
  readonly fake: FakeIpc;
  readonly log: ReturnType<typeof vi.fn>;
  readonly trusted: IpcMainInvokeEvent;
  readonly untrusted: IpcMainInvokeEvent;
}

function setup(): Setup {
  const manager = createManager();
  const fake = createFakeIpc();
  const log = vi.fn();
  // The real check compares the sender's webContents and frame; identity is enough here.
  const trusted = { sender: 'main-window' } as unknown as IpcMainInvokeEvent;
  const untrusted = { sender: 'another-page' } as unknown as IpcMainInvokeEvent;
  registerTerminalIpc({
    ipc: fake.ipc,
    manager,
    isTrustedSender: (event) => event === trusted,
    log,
  });
  return { manager, fake, log, trusted, untrusted };
}

const GOOD_OPEN = { chatId: 'chat-1', cwd: null, cols: 80, rows: 24 };

describe('registerTerminalIpc channels', () => {
  it('registers every inbound channel and no outbound one', () => {
    const { fake } = setup();
    expect([...fake.handled.keys()].sort()).toStrictEqual(
      [TERMINAL_IPC.open, TERMINAL_IPC.read, TERMINAL_IPC.close].sort(),
    );
    expect([...fake.listened.keys()].sort()).toStrictEqual([TERMINAL_IPC.write, TERMINAL_IPC.resize].sort());
    // data and exit only go the other way.
    expect([...fake.handled.keys(), ...fake.listened.keys()].sort()).toStrictEqual(
      [TERMINAL_IPC.open, TERMINAL_IPC.read, TERMINAL_IPC.close, TERMINAL_IPC.write, TERMINAL_IPC.resize].sort(),
    );
    expect(fake.handled.has(TERMINAL_IPC.data)).toBe(false);
    expect(fake.listened.has(TERMINAL_IPC.data)).toBe(false);
    expect(fake.handled.has(TERMINAL_IPC.exit)).toBe(false);
    expect(fake.listened.has(TERMINAL_IPC.exit)).toBe(false);
  });
});

describe('registerTerminalIpc sender check', () => {
  it('rejects an untrusted sender on every inbound channel and never reaches the manager', async () => {
    const { fake, manager, log, untrusted } = setup();

    await expect(fake.invoke(TERMINAL_IPC.open, untrusted, GOOD_OPEN)).rejects.toThrow(UNTRUSTED_SENDER);
    await expect(fake.invoke(TERMINAL_IPC.read, untrusted, 'chat-1', {})).rejects.toThrow(UNTRUSTED_SENDER);
    await expect(fake.invoke(TERMINAL_IPC.close, untrusted, 'chat-1')).rejects.toThrow(UNTRUSTED_SENDER);
    expect(() => fake.send(TERMINAL_IPC.write, untrusted, 'chat-1', 'ls\r')).not.toThrow();
    expect(() => fake.send(TERMINAL_IPC.resize, untrusted, 'chat-1', 100, 30)).not.toThrow();

    expect(manager.open).not.toHaveBeenCalled();
    expect(manager.read).not.toHaveBeenCalled();
    expect(manager.close).not.toHaveBeenCalled();
    expect(manager.write).not.toHaveBeenCalled();
    expect(manager.resize).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('untrusted'));
  });

  it('treats a throwing sender check as untrusted', async () => {
    const manager = createManager();
    const fake = createFakeIpc();
    registerTerminalIpc({
      ipc: fake.ipc,
      manager,
      isTrustedSender: () => {
        throw new Error('senderFrame is gone');
      },
      log: vi.fn(),
    });

    await expect(fake.invoke(TERMINAL_IPC.open, {}, GOOD_OPEN)).rejects.toThrow(UNTRUSTED_SENDER);
    expect(() => fake.send(TERMINAL_IPC.write, {}, 'chat-1', 'x')).not.toThrow();
    expect(manager.open).not.toHaveBeenCalled();
    expect(manager.write).not.toHaveBeenCalled();
  });
});

describe('registerTerminalIpc valid calls', () => {
  it('passes validated values to the manager on every channel', async () => {
    const { fake, manager, trusted } = setup();

    await expect(
      fake.invoke(TERMINAL_IPC.open, trusted, { chatId: 'chat-1', cwd: '/project', cols: 120, rows: 40 }),
    ).resolves.toBe(OPEN_RESULT);
    await expect(fake.invoke(TERMINAL_IPC.read, trusted, 'chat-1', { startLine: 2, count: 5 })).resolves.toBe(
      READ_ANSWER,
    );
    await expect(fake.invoke(TERMINAL_IPC.close, trusted, 'chat-1')).resolves.toBeUndefined();
    fake.send(TERMINAL_IPC.write, trusted, 'chat-1', 'ls\r');
    fake.send(TERMINAL_IPC.resize, trusted, 'chat-1', 120, 40);

    expect(manager.open).toHaveBeenCalledWith({ chatId: 'chat-1', cwd: '/project', cols: 120, rows: 40 });
    expect(manager.read).toHaveBeenCalledWith('chat-1', { startLine: 2, count: 5 });
    expect(manager.close).toHaveBeenCalledWith('chat-1');
    expect(manager.write).toHaveBeenCalledWith('chat-1', 'ls\r');
    expect(manager.resize).toHaveBeenCalledWith('chat-1', 120, 40);
  });

  it('passes restart: true through to the manager, and refuses a restart that is not a boolean', async () => {
    const { fake, manager, trusted } = setup();
    await fake.invoke(TERMINAL_IPC.open, trusted, { ...GOOD_OPEN, restart: true });
    expect(manager.open).toHaveBeenLastCalledWith({ ...GOOD_OPEN, restart: true });
    await expect(fake.invoke(TERMINAL_IPC.open, trusted, { ...GOOD_OPEN, restart: 'yes' })).rejects.toThrow(
      INVALID_REQUEST,
    );
    expect(manager.open).toHaveBeenCalledTimes(1);
  });

  it('accepts a read with no request as the default range', async () => {
    const { fake, manager, trusted } = setup();
    await fake.invoke(TERMINAL_IPC.read, trusted, 'chat-1');
    expect(manager.read).toHaveBeenCalledWith('chat-1', {});
  });

  it('forwards the read answer unchanged', async () => {
    const { fake, manager, trusted } = setup();
    const answer: TerminalReadAnswer = { ok: false, reason: 'no_terminal' };
    manager.read.mockResolvedValueOnce(answer);
    await expect(fake.invoke(TERMINAL_IPC.read, trusted, 'chat-1', {})).resolves.toBe(answer);
  });

  it('turns a throwing read into unavailable instead of a rejection', async () => {
    const { fake, manager, trusted } = setup();
    manager.read.mockRejectedValueOnce(new Error('read failed'));
    await expect(fake.invoke(TERMINAL_IPC.read, trusted, 'chat-1', {})).resolves.toStrictEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('propagates a refused open', async () => {
    const { fake, manager, trusted } = setup();
    manager.open.mockRejectedValueOnce(new Error('At most 8 terminals can run at once. End one to open another.'));
    await expect(fake.invoke(TERMINAL_IPC.open, trusted, GOOD_OPEN)).rejects.toThrow(/at most 8/i);
  });

  it('clamps cols and rows to the contract limits', async () => {
    const { fake, manager, trusted } = setup();

    fake.send(TERMINAL_IPC.resize, trusted, 'chat-1', 0, 1);
    expect(manager.resize).toHaveBeenLastCalledWith('chat-1', TERMINAL.minCols, TERMINAL.minRows);

    fake.send(TERMINAL_IPC.resize, trusted, 'chat-1', 100_000, 100_000);
    expect(manager.resize).toHaveBeenLastCalledWith('chat-1', TERMINAL.maxCols, TERMINAL.maxRows);

    fake.send(TERMINAL_IPC.resize, trusted, 'chat-1', 99.9, 39.9);
    expect(manager.resize).toHaveBeenLastCalledWith('chat-1', 99, 39);

    await fake.invoke(TERMINAL_IPC.open, trusted, { chatId: 'chat-1', cwd: null, cols: 0, rows: 0 });
    expect(manager.open).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      cwd: null,
      cols: TERMINAL.minCols,
      rows: TERMINAL.minRows,
    });
  });
});

describe('registerTerminalIpc malformed open', () => {
  const cases: Array<{ name: string; payload: unknown }> = [
    { name: 'null', payload: null },
    { name: 'undefined', payload: undefined },
    { name: 'a number', payload: 7 },
    { name: 'a string', payload: 'chat-1' },
    { name: 'an array', payload: [] },
    { name: 'a missing chat id', payload: { cwd: null, cols: 80, rows: 24 } },
    { name: 'a bad chat id', payload: { chatId: 'bad id', cwd: null, cols: 80, rows: 24 } },
    { name: 'a non-string cwd', payload: { chatId: 'chat-1', cwd: 5, cols: 80, rows: 24 } },
    { name: 'a NUL in cwd', payload: { chatId: 'chat-1', cwd: '/tmp/a\0b', cols: 80, rows: 24 } },
    { name: 'a missing size', payload: { chatId: 'chat-1', cwd: null } },
    { name: 'NaN cols', payload: { chatId: 'chat-1', cwd: null, cols: Number.NaN, rows: 24 } },
    { name: 'Infinity rows', payload: { chatId: 'chat-1', cwd: null, cols: 80, rows: Number.POSITIVE_INFINITY } },
    { name: 'string cols', payload: { chatId: 'chat-1', cwd: null, cols: '80', rows: 24 } },
    { name: 'null rows', payload: { chatId: 'chat-1', cwd: null, cols: 80, rows: null } },
  ];

  it.each(cases)('rejects $name without throwing or reaching the manager', async ({ payload }) => {
    const { fake, manager, trusted } = setup();
    await expect(fake.invoke(TERMINAL_IPC.open, trusted, payload)).rejects.toThrow(INVALID_REQUEST);
    expect(manager.open).not.toHaveBeenCalled();
  });
});

describe('registerTerminalIpc malformed read', () => {
  const cases: Array<{ name: string; chatId: unknown; request: unknown }> = [
    { name: 'a null chat id', chatId: null, request: {} },
    { name: 'a numeric chat id', chatId: 7, request: {} },
    { name: 'an empty chat id', chatId: '', request: {} },
    { name: 'a chat id with a space', chatId: 'bad id', request: {} },
    { name: 'the index chat id', chatId: 'index', request: {} },
    { name: 'a huge chat id', chatId: 'x'.repeat(129), request: {} },
    { name: 'a null request', chatId: 'chat-1', request: null },
    { name: 'a string request', chatId: 'chat-1', request: 'last 10' },
    { name: 'a zero startLine', chatId: 'chat-1', request: { startLine: 0 } },
    { name: 'a fractional startLine', chatId: 'chat-1', request: { startLine: 1.5 } },
    { name: 'a negative count', chatId: 'chat-1', request: { count: -1 } },
    { name: 'a zero count', chatId: 'chat-1', request: { count: 0 } },
    { name: 'NaN startLine', chatId: 'chat-1', request: { startLine: Number.NaN } },
    { name: 'string count', chatId: 'chat-1', request: { count: '5' } },
  ];

  it.each(cases)('answers unavailable for $name without throwing', async ({ chatId, request }) => {
    const { fake, manager, trusted } = setup();
    await expect(fake.invoke(TERMINAL_IPC.read, trusted, chatId, request)).resolves.toStrictEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(manager.read).not.toHaveBeenCalled();
  });
});

describe('registerTerminalIpc malformed close', () => {
  const cases: Array<{ name: string; chatId: unknown }> = [
    { name: 'null', chatId: null },
    { name: 'undefined', chatId: undefined },
    { name: 'a number', chatId: 7 },
    { name: 'an empty string', chatId: '' },
    { name: 'a bad id', chatId: 'bad id' },
    { name: 'the index id', chatId: 'index' },
  ];

  it.each(cases)('resolves for $name without reaching the manager', async ({ chatId }) => {
    const { fake, manager, trusted } = setup();
    await expect(fake.invoke(TERMINAL_IPC.close, trusted, chatId)).resolves.toBeUndefined();
    expect(manager.close).not.toHaveBeenCalled();
  });
});

describe('registerTerminalIpc malformed write', () => {
  const cases: Array<{ name: string; chatId: unknown; data: unknown }> = [
    { name: 'a null chat id', chatId: null, data: 'ls\r' },
    { name: 'a bad chat id', chatId: 'bad id', data: 'ls\r' },
    { name: 'missing data', chatId: 'chat-1', data: undefined },
    { name: 'a number as data', chatId: 'chat-1', data: 42 },
    { name: 'null data', chatId: 'chat-1', data: null },
    { name: 'an object as data', chatId: 'chat-1', data: { data: 'ls' } },
    { name: 'data over writeMaxBytes', chatId: 'chat-1', data: 'a'.repeat(TERMINAL.writeMaxBytes + 1) },
    {
      name: 'multibyte data over writeMaxBytes',
      chatId: 'chat-1',
      data: '😀'.repeat(TERMINAL.writeMaxBytes / 2),
    },
  ];

  it.each(cases)('ignores $name without throwing or reporting invalid payloads', ({ chatId, data }) => {
    const { fake, manager, trusted, log } = setup();
    expect(() => fake.send(TERMINAL_IPC.write, trusted, chatId, data)).not.toThrow();
    expect(manager.write).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid payload'));
  });
});

describe('registerTerminalIpc malformed resize', () => {
  const cases: Array<{ name: string; chatId: unknown; cols: unknown; rows: unknown }> = [
    { name: 'a null chat id', chatId: null, cols: 80, rows: 24 },
    { name: 'a bad chat id', chatId: 'bad id', cols: 80, rows: 24 },
    { name: 'NaN cols', chatId: 'chat-1', cols: Number.NaN, rows: 24 },
    { name: 'infinite rows', chatId: 'chat-1', cols: 80, rows: Number.POSITIVE_INFINITY },
    { name: 'string cols', chatId: 'chat-1', cols: '80', rows: 24 },
    { name: 'null rows', chatId: 'chat-1', cols: 80, rows: null },
    { name: 'a missing rows', chatId: 'chat-1', cols: 80, rows: undefined },
  ];

  it.each(cases)('ignores $name without throwing', ({ chatId, cols, rows }) => {
    const { fake, manager, trusted, log } = setup();
    expect(() => fake.send(TERMINAL_IPC.resize, trusted, chatId, cols, rows)).not.toThrow();
    expect(manager.resize).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid payload'));
  });
});
