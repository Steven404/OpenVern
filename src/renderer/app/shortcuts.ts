import { isTerminalFocused } from '@renderer/features/terminal/dom';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useNewChatPath } from './queries';

const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"]';

/** True while a modal dialog or menu is on screen: global shortcuts stay out of the way. */
export function isOverlayOpen(): boolean {
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

export interface GlobalShortcutHandlers {
  toggleSidebar(): void;
  /** `Ctrl+]`. Undefined where there is no right panel. */
  toggleRightPanel?: () => void;
  /** `Ctrl+backtick`: show or hide the terminal dock. Undefined where there is no terminal (web build, new-chat screen). */
  toggleTerminal?: () => void;
}

/**
 * Global keyboard shortcuts (S6.9): `Ctrl+N` → New chat (with the current chat's project preselected),
 * `Ctrl+B` → toggle the sidebar, `Ctrl+]` → toggle the right panel (a chat, or the new-chat screen), `Ctrl+backtick` →
 * toggle the terminal dock. `Cmd` works like `Ctrl` for the first three (labels show `⌘` on macOS, see `modKeyLabel`).
 *
 * The terminal shortcut is `Ctrl` on macOS too, as in Cursor, because `Cmd+backtick` cycles windows. While the terminal
 * has focus it is the only shortcut handled, so `Ctrl+B`, `Ctrl+N` and the rest reach the shell (terminal plan §5).
 * Everything is ignored while a dialog or menu is open. (Browsers reserve `Ctrl+N`; it works in Electron.) The listener
 * runs in the capture phase so the terminal key never reaches xterm.
 */
export function useGlobalShortcuts({ toggleSidebar, toggleRightPanel, toggleTerminal }: GlobalShortcutHandlers): void {
  const navigate = useNavigate();
  const newChatPath = useNewChatPath();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isOverlayOpen()) return;
      // `code` catches layouts where the backtick key produces another character (the physical key is the same).
      if (
        (event.code === 'Backquote' || event.key === '`') &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        if (!toggleTerminal) return;
        event.preventDefault();
        event.stopPropagation();
        toggleTerminal();
        return;
      }
      if (isTerminalFocused()) return;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        navigate(newChatPath);
      } else if (key === 'b') {
        event.preventDefault();
        toggleSidebar();
      } else if (key === ']' && toggleRightPanel) {
        event.preventDefault();
        toggleRightPanel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [navigate, newChatPath, toggleSidebar, toggleRightPanel, toggleTerminal]);
}
