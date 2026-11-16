// Surface slot API. A "surface" is a full-height view in the right panel (Files, Terminal, Diff). The launcher and
// tab strip are driven by this registry. G5 plugs the Diff surface in by replacing the `diff` entry's `Component`
// (G5: `DiffSurface`). The terminal is the exception: it is a dock under the composer, so its row opens that instead
// of a panel tab (terminal plan §2, "Placement"; §5 "Launcher row").

import type { Id } from '@shared/types';
import type { ComponentType, ReactNode } from 'react';
import { DiffSurface } from '../changes/DiffSurface';
import { FilesSurface } from '../files/FilesSurface';
import { hasTerminalBridge } from '../terminal/bridge';
import { openTerminalDock } from '../terminal/terminal-store';
import { DiffIcon, FilesIcon, TerminalIcon } from './icons';

export type SurfaceId = 'files' | 'terminal' | 'diff';

export interface SurfaceContext {
  chatId: Id;
  /** `null` for a chat without a project. */
  projectId: Id | null;
  /** The chat has pending or applied edits (`chatChanges` query). */
  hasChanges: boolean;
  /**
   * The New Chat screen, which has no chat yet. Its terminal is kept under the draft id and moves into the chat on the
   * first send; with no project it starts in Documents rather than home.
   */
  draft: boolean;
}

export interface SurfaceProps {
  chatId: Id;
  /** `undefined` while the chat's project is still loading. `null` means there is no project (list the home folder). */
  projectId: Id | null | undefined;
  /**
   * What the last `openPanelSurface(chatId, id, params)` passed (`{}` if nothing). A new object per call, so an
   * effect keyed on it re-runs when the same file is opened again.
   */
  params: unknown;
}

export interface SurfaceDefinition {
  id: SurfaceId;
  label: string;
  /** Launcher shortcut, pressed while the launcher has focus. */
  key: string;
  icon: ReactNode;
  /** Launcher hint, and why the row is disabled. */
  availability(ctx: SurfaceContext): { enabled: boolean; hint: string };
  /** `pinned` surfaces always have the first tab (Files); others get a closable tab once opened. */
  tab: 'pinned' | 'opened';
  /** Absent = no panel body (the terminal opens the dock instead). */
  Component?: ComponentType<SurfaceProps>;
  /** Opens something outside the panel instead of a tab: the launcher calls this before `onOpen`. */
  onSelect?(ctx: SurfaceContext): void;
}

const registry: SurfaceDefinition[] = [
  {
    id: 'files',
    label: 'Files',
    key: 'F',
    icon: <FilesIcon size={18} />,
    availability: ({ projectId }) =>
      projectId
        ? { enabled: true, hint: 'Browse the project, read-only' }
        : { enabled: true, hint: 'Browse your home folder, read-only' },
    tab: 'pinned',
    Component: FilesSurface,
  },
  {
    id: 'terminal',
    label: 'Terminal',
    key: 'T',
    icon: <TerminalIcon />,
    availability: ({ draft, projectId }) => {
      if (!hasTerminalBridge()) return { enabled: false, hint: 'Available in the desktop app' };
      if (projectId) return { enabled: true, hint: 'Open a shell in the project folder' };
      return {
        enabled: true,
        hint: draft ? 'Open a shell in your Documents folder' : 'Open a shell in your home folder',
      };
    },
    tab: 'opened',
    // Not a panel tab: the row opens the dock under the composer (terminal plan §2, "Opening").
    onSelect: ({ chatId }) => openTerminalDock(chatId),
  },
  {
    id: 'diff',
    label: 'Diff',
    key: 'D',
    icon: <DiffIcon />,
    availability: ({ hasChanges }) =>
      hasChanges
        ? { enabled: true, hint: 'Review the edits this chat proposed' }
        : { enabled: false, hint: 'Available after the current chat has made edits' },
    tab: 'opened',
    Component: DiffSurface,
  },
];

/** Replace (by id) or add a surface definition. */
export function registerSurface(def: SurfaceDefinition): void {
  const i = registry.findIndex((d) => d.id === def.id);
  if (i >= 0) registry[i] = def;
  else registry.push(def);
}

export const getSurfaces = (): readonly SurfaceDefinition[] => registry;
export const getSurface = (id: SurfaceId): SurfaceDefinition | undefined => registry.find((d) => d.id === id);
