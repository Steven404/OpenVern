// Layout of the design: sidebar (272px) + main. Also owns sidebar collapse (D2), the narrow-window overlay (D19),
// global shortcuts, and the two app-level modals (Settings, New project).

import { IconButton } from '@renderer/components/ui';
import { NewProjectModal } from '@renderer/features/projects';
import { SettingsModal } from '@renderer/features/settings';
import { SIDEBAR_COLLAPSE_BUTTON_ID, Sidebar } from '@renderer/features/sidebar';
import { PanelIcon } from '@renderer/features/sidebar/icons';
import { useUiStore } from '@renderer/stores/ui';
import { APP_NAME } from '@shared/constants';
import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router';
import { useCurrentChatId } from './queries';
import { useGlobalShortcuts } from './shortcuts';
import { NARROW_QUERY, useMediaQuery } from './useMediaQuery';

const OPEN_SIDEBAR_BUTTON_ID = 'sidebar-open';

export function AppShell() {
  const narrow = useMediaQuery(NARROW_QUERY);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const overlayOpen = useUiStore((s) => s.sidebarOverlayOpen);
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const setOverlayOpen = useUiStore((s) => s.setSidebarOverlayOpen);
  const location = useLocation();
  const currentChatId = useCurrentChatId();

  // `ChatHeader` titles the window after its chat; everywhere else it is just the app name.
  useEffect(() => {
    if (!currentChatId) document.title = APP_NAME;
  }, [currentChatId]);

  // Wide windows remember a collapsed sidebar; narrow windows always start with it closed (D19).
  const visible = narrow ? overlayOpen : !collapsed;

  // Focus follows the button the user pressed (the pressed button unmounts with its sidebar / main-area slot).
  const pendingFocus = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when visibility flips, nothing else
  useEffect(() => {
    const id = pendingFocus.current;
    pendingFocus.current = null;
    if (id) document.getElementById(id)?.focus();
  }, [visible]);

  const setVisible = useCallback(
    (next: boolean) => (narrow ? setOverlayOpen(next) : setCollapsed(!next)),
    [narrow, setOverlayOpen, setCollapsed],
  );
  const toggleSidebar = useCallback(() => setVisible(!visible), [setVisible, visible]);
  const closeOverlay = useCallback(() => setOverlayOpen(false), [setOverlayOpen]);

  // Picking a chat (or leaving narrow mode) closes the overlay.
  // biome-ignore lint/correctness/useExhaustiveDependencies: location is the trigger
  useEffect(() => {
    setOverlayOpen(false);
  }, [location.pathname, location.search, narrow, setOverlayOpen]);

  useGlobalShortcuts({
    toggleSidebar,
    closeSidebarOverlay: narrow && overlayOpen ? closeOverlay : undefined,
  });

  return (
    <div className="flex h-full w-full overflow-hidden bg-(image:--backdrop) bg-bg text-text">
      {narrow && visible ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close sidebar"
          onClick={closeOverlay}
          className="fixed inset-0 z-30 cursor-default bg-black/60"
        />
      ) : null}
      {visible ? (
        <Sidebar
          className={narrow ? 'fixed inset-y-0 left-0 z-40 shadow-2xl' : undefined}
          onCollapse={() => {
            pendingFocus.current = OPEN_SIDEBAR_BUTTON_ID;
            setVisible(false);
          }}
        />
      ) : null}

      <main
        data-sidebar-hidden={visible ? undefined : ''}
        className="group relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {visible ? null : (
          <IconButton
            id={OPEN_SIDEBAR_BUTTON_ID}
            aria-label="Open sidebar"
            className="absolute top-3.5 left-4 z-10"
            onClick={() => {
              pendingFocus.current = SIDEBAR_COLLAPSE_BUTTON_ID;
              setVisible(true);
            }}
          >
            <PanelIcon />
          </IconButton>
        )}
        <Outlet />
      </main>

      <SettingsModal />
      <NewProjectModal />
    </div>
  );
}
