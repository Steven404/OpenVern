// Layout of the design: sidebar (272px) + chat column (+ right panel, v0.2). Also owns sidebar collapse (D2),
// global shortcuts, and the two app-level modals (Settings, New project).
//
// The row never wraps: the chat column keeps `LAYOUT.conversationMin`, the panel `LAYOUT.panelMin`, and the root has
// the window's minimum size, so a smaller browser window scrolls instead of reflowing (the narrow overlay is gone).

import { IconButton } from '@renderer/components/ui';
import { NewProjectModal } from '@renderer/features/projects';
import { RightPanel } from '@renderer/features/right-panel';
import { SettingsModal } from '@renderer/features/settings';
import { SIDEBAR_COLLAPSE_BUTTON_ID, Sidebar } from '@renderer/features/sidebar';
import { PanelIcon } from '@renderer/features/sidebar/icons';
import { useUiStore } from '@renderer/stores/ui';
import { APP_NAME, LAYOUT } from '@shared/constants';
import { useCallback, useEffect, useRef } from 'react';
import { Outlet } from 'react-router';
import { useCurrentChatId, useRightPanelTarget } from './queries';
import { useGlobalShortcuts } from './shortcuts';

const OPEN_SIDEBAR_BUTTON_ID = 'sidebar-open';

export function AppShell() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const panelOpen = useUiStore((s) => s.rightPanelOpen);
  const currentChatId = useCurrentChatId();
  const panelTarget = useRightPanelTarget();

  // `ChatHeader` titles the window after its chat; everywhere else it is just the app name.
  useEffect(() => {
    if (!currentChatId) document.title = APP_NAME;
  }, [currentChatId]);

  const visible = !collapsed;

  // Focus follows the button the user pressed (the pressed button unmounts with its sidebar / main-area slot).
  const pendingFocus = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when visibility flips, nothing else
  useEffect(() => {
    const id = pendingFocus.current;
    pendingFocus.current = null;
    if (id) document.getElementById(id)?.focus();
  }, [visible]);

  const setVisible = useCallback((next: boolean) => setCollapsed(!next), [setCollapsed]);
  const toggleSidebar = useCallback(() => setVisible(!visible), [setVisible, visible]);

  useGlobalShortcuts({ toggleSidebar, toggleRightPanel: panelTarget ? toggleRightPanel : undefined });

  return (
    <div
      className="flex h-full w-full flex-nowrap overflow-hidden bg-bg text-text"
      style={{ minWidth: LAYOUT.windowMinWidth, minHeight: LAYOUT.windowMinHeight }}
    >
      {visible ? (
        <Sidebar
          onCollapse={() => {
            pendingFocus.current = OPEN_SIDEBAR_BUTTON_ID;
            setVisible(false);
          }}
        />
      ) : null}

      <main
        data-sidebar-hidden={visible ? undefined : ''}
        className="group relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={{ minWidth: LAYOUT.conversationMin }}
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

      {panelTarget && panelOpen ? <RightPanel chatId={panelTarget.chatId} projectId={panelTarget.projectId} /> : null}

      <SettingsModal />
      <NewProjectModal />
    </div>
  );
}
