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
  const clearFocusRequestsExcept = useTerminalUiStore((s) => s.clearFocusRequestsExcept);
  const bridged = hasTerminalBridge();

  // A request that was not consumed before the user moved on would otherwise make a later mount of that chat's dock
  // steal focus from its composer.
  useEffect(() => {
    clearFocusRequestsExcept(chatId);
  }, [chatId, clearFocusRequestsExcept]);

  const toggle = useCallback(() => {
    if (!chatId || !bridged) return;
    if (open) {
      closeDock(chatId);
      focusComposer();
    } else {
      openDock(chatId);
    }
  }, [chatId, bridged, open, openDock, closeDock]);

  return { open, shortcut: chatId && bridged ? toggle : undefined };
}

/**
 * T3.4: deleting a chat ends its terminal. A chat that was in a loaded chats list and then left it is the renderer's
 * signal; a chat that was never there (the URL of a deleted chat, or a list that has only partly loaded) is not, and
 * keeps any session it may have. The effect waits for a quiet list, so a refetch in flight cannot close a shell that a
 * partial answer merely omits. `close` resolves when there is no session, so a chat without a dock costs one IPC call.
 */
export function useCloseDeletedTerminals(): void {
  const chats = useChats();
  const seen = useRef<Set<Id>>(new Set());

  useEffect(() => {
    const list = chats.data;
    // A list being refetched keeps the previous data on screen; only a settled answer may mean a deletion.
    if (!list || chats.isFetching) return;
    const ids = new Set(list.map((chat) => chat.id));
    const bridge = getTerminalBridge();
    for (const id of seen.current) {
      if (ids.has(id)) continue;
      seen.current.delete(id);
      useTerminalUiStore.getState().closeDock(id);
      if (!bridge) continue;
      void import('./registry').then(({ terminalRegistry }) => {
        terminalRegistry.dispose(id);
        if (bridge) void bridge.close(id).catch(() => {});
      });
    }
    for (const id of ids) seen.current.add(id);
  }, [chats.data, chats.isFetching]);
}
