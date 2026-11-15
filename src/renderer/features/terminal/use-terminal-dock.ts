// App-level wiring for the terminal dock: the `Ctrl`+backtick toggle, focus return, and the one place that ends a
// session the renderer no longer needs (a deleted chat). The dock component itself lives in `TerminalDock.tsx`.

import { useChats } from '@renderer/app/queries';
import type { Id } from '@shared/types';
import { useCallback, useEffect, useRef } from 'react';
import { focusComposer } from '../composer/focus';
import { getTerminalBridge, hasTerminalBridge } from './bridge';
import { selectDockOpen, useTerminalUiStore } from './terminal-store';

export interface TerminalDockState {
  /** The chat's dock is open. */
  open: boolean;
  /** `Ctrl`+backtick: show the dock and focus the terminal, or hide it and give the composer focus back. */
  hide(): void;
  /**
   * The open/close handler for the global shortcut, or `undefined` where there is nothing to toggle: no chat on screen
   * (the new-chat screen has no terminal) or no bridge (the web build).
   */
  shortcut: (() => void) | undefined;
}

export function useTerminalDock(chatId: Id | undefined): TerminalDockState {
  const open = useTerminalUiStore(selectDockOpen(chatId));
  const openDock = useTerminalUiStore((s) => s.openDock);
  const closeDock = useTerminalUiStore((s) => s.closeDock);
  const bridged = hasTerminalBridge();

  const hide = useCallback(() => {
    if (!chatId) return;
    closeDock(chatId);
    focusComposer();
  }, [chatId, closeDock]);

  const toggle = useCallback(() => {
    if (!chatId || !bridged) return;
    if (open) hide();
    else openDock(chatId);
  }, [chatId, bridged, open, openDock, hide]);

  return { open, hide, shortcut: chatId && bridged ? toggle : undefined };
}

/**
 * T3.4: deleting a chat ends its terminal. The id leaving the chats list is the renderer's signal (a delete, or a chat
 * that vanished server-side); every other change keeps the chat in the list, so archiving does not lose the shell.
 * `close` resolves when there is no session, so a chat without a dock costs one IPC call.
 */
export function useCloseDeletedTerminals(): void {
  const chats = useChats();
  const seen = useRef<Set<Id>>(new Set());

  useEffect(() => {
    const list = chats.data;
    if (!list) return;
    const ids = new Set(list.map((chat) => chat.id));
    const bridge = getTerminalBridge();
    for (const id of seen.current) {
      if (ids.has(id)) continue;
      seen.current.delete(id);
      useTerminalUiStore.getState().closeDock(id);
      if (bridge) void bridge.close(id).catch(() => {});
    }
    for (const id of ids) seen.current.add(id);
  }, [chats.data]);
}
