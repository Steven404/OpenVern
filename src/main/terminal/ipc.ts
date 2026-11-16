// The terminal's IPC handlers (plan T1.5): `open`, `list`, `close` and `adopt` are invoked, `write` and `resize` are
// sent.
// Every handler first checks the sender, then the payload. Nothing here throws out of an `on` listener (that would be
// an uncaught exception in main); invoke handlers reject only an untrusted sender, a bad or refused `open`, and a bad
// `adopt`.
// `data` and `exit` go the other way and are sent by ./service.ts, to the main window only.

import { TERMINAL_IPC, type TerminalInfo, type TerminalOpenResult } from '@shared/terminal';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type { TerminalManager } from './manager';
import { parseAdopt, parseChatId, parseOpenRequest, parseSize, parseWriteData } from './validate';

/** The part of `ipcMain` used here, so tests can pass a fake. */
export interface TerminalIpcMain {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void;
}

export interface TerminalIpcDeps {
  ipc: TerminalIpcMain;
  manager: Pick<TerminalManager, 'open' | 'list' | 'write' | 'resize' | 'close' | 'adopt'>;
  /** True only for the app's own page in the main window. */
  isTrustedSender: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  log?: (message: string) => void;
}

export const UNTRUSTED_SENDER = 'terminal: untrusted sender';
export const INVALID_REQUEST = 'terminal: invalid request';

export function registerTerminalIpc({ ipc, manager, isTrustedSender, log = console.warn }: TerminalIpcDeps): void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean => {
    let ok = false;
    try {
      ok = isTrustedSender(event);
    } catch {
      ok = false;
    }
    if (!ok) log(`[openvern] ${channel}: untrusted sender, ignored`);
    return ok;
  };

  ipc.handle(TERMINAL_IPC.open, async (event, req): Promise<TerminalOpenResult> => {
    if (!trusted(event, TERMINAL_IPC.open)) throw new Error(UNTRUSTED_SENDER);
    const params = parseOpenRequest(req);
    if (!params) throw new Error(INVALID_REQUEST);
    return manager.open(params);
  });

  ipc.handle(TERMINAL_IPC.list, async (event): Promise<TerminalInfo[]> => {
    if (!trusted(event, TERMINAL_IPC.list)) throw new Error(UNTRUSTED_SENDER);
    return manager.list();
  });

  ipc.handle(TERMINAL_IPC.close, async (event, chatId): Promise<void> => {
    if (!trusted(event, TERMINAL_IPC.close)) throw new Error(UNTRUSTED_SENDER);
    const id = parseChatId(chatId);
    // No session can exist under a malformed id, so there is nothing to close.
    if (id) await manager.close(id);
  });

  // Moves the New Chat screen's session to the chat just created from it. Only the draft id can be moved, never onto
  // the draft id, and a chat that already has a session keeps it (the manager answers false). Never spawns.
  ipc.handle(TERMINAL_IPC.adopt, async (event, from, to): Promise<boolean> => {
    if (!trusted(event, TERMINAL_IPC.adopt)) throw new Error(UNTRUSTED_SENDER);
    const ids = parseAdopt(from, to);
    if (!ids) throw new Error(INVALID_REQUEST);
    return manager.adopt(ids.from, ids.to);
  });

  ipc.on(TERMINAL_IPC.write, (event, chatId, data) => {
    try {
      if (!trusted(event, TERMINAL_IPC.write)) return;
      const id = parseChatId(chatId);
      const text = parseWriteData(data);
      if (!id || text === null) {
        log(`[openvern] ${TERMINAL_IPC.write}: invalid payload, ignored`);
        return;
      }
      manager.write(id, text);
    } catch (err) {
      log(`[openvern] ${TERMINAL_IPC.write} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ipc.on(TERMINAL_IPC.resize, (event, chatId, cols, rows) => {
    try {
      if (!trusted(event, TERMINAL_IPC.resize)) return;
      const id = parseChatId(chatId);
      const size = parseSize(cols, rows);
      if (!id || !size) {
        log(`[openvern] ${TERMINAL_IPC.resize}: invalid payload, ignored`);
        return;
      }
      manager.resize(id, size.cols, size.rows);
    } catch (err) {
      log(`[openvern] ${TERMINAL_IPC.resize} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
