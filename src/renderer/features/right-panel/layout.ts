// Panel sizing shared by the right panel and its surfaces. A separate module so surfaces can use it without
// importing RightPanel (which imports the surfaces).

import { LAYOUT } from '@shared/constants';

/** The widest the right panel can be: the window minus the sidebar and the conversation's minimum. */
export function availablePanelWidth(sidebarCollapsed: boolean, viewport: number): number {
  const sidebar = sidebarCollapsed ? 0 : LAYOUT.sidebar;
  return Math.max(LAYOUT.panelMin, viewport - sidebar - LAYOUT.conversationMin);
}
