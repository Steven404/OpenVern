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
  /** Escape closes the narrow-window sidebar overlay. */
  closeSidebarOverlay?: () => void;
}

/**
 * Global keyboard shortcuts (S6.9): `Ctrl+N` → New chat (with the current chat's project preselected),
 * `Ctrl+B` → toggle the sidebar, `Escape` → close the sidebar overlay. `Cmd` works like `Ctrl`.
 * Ignored while a dialog or menu is open. (Browsers reserve `Ctrl+N`; it works in Electron.)
 */
export function useGlobalShortcuts({ toggleSidebar, closeSidebarOverlay }: GlobalShortcutHandlers): void {
  const navigate = useNavigate();
  const newChatPath = useNewChatPath();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isOverlayOpen()) return;
      if (event.key === 'Escape') {
        closeSidebarOverlay?.();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        navigate(newChatPath);
      } else if (key === 'b') {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, newChatPath, toggleSidebar, closeSidebarOverlay]);
}
