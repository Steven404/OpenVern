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
  /**
   * `Ctrl+backtick`: show or hide the terminal dock (a chat's, or the New Chat screen's draft one). Undefined where
   * there is no terminal (the web build, or a screen that is neither).
   */
  toggleTerminal?: () => void;
}

/**
 * Global keyboard shortcuts (S6.9): `Ctrl+N` → New chat (with the current chat's project preselected),
 * `Ctrl+B` → toggle the sidebar, `Ctrl+]` → toggle the right panel (a chat, or the new-chat screen). `Cmd` works like `Ctrl`
 * (labels show `⌘` on macOS, see `modKeyLabel`).
 * Ignored while a dialog or menu is open. (Browsers reserve `Ctrl+N`; it works in Electron.)
 *
 * The terminal shortcut is `Ctrl`+backtick on every platform, as in Cursor (`Cmd+backtick` cycles windows on macOS). It
 * runs in a capture-phase listener of its own, so it also works while xterm has focus and stops the key before it can
 * reach the shell. The three long-standing shortcuts keep their original bubble-phase listener: while the terminal has
 * focus, their `Ctrl` forms are left to the shell, but the `Cmd` forms still work because Cmd never reaches it.
 */
export function useGlobalShortcuts({ toggleSidebar, toggleRightPanel, toggleTerminal }: GlobalShortcutHandlers): void {
  const navigate = useNavigate();
  const newChatPath = useNewChatPath();

  useEffect(() => {
    // `Ctrl+backtick`, capture: the one shortcut that must win over a focused terminal.
    const onTerminalKeyDown = (event: KeyboardEvent) => {
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
      }
    };
    // The other shortcuts, bubble phase, exactly as before the terminal existed.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isOverlayOpen()) return;
      // While the terminal has focus, Ctrl belongs to the shell. Cmd does not reach the shell, so it keeps working.
      if (isTerminalFocused() && event.ctrlKey && !event.metaKey) return;
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
    window.addEventListener('keydown', onTerminalKeyDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onTerminalKeyDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [navigate, newChatPath, toggleSidebar, toggleRightPanel, toggleTerminal]);
}
