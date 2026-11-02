// Surface slot API. A "surface" is a full-height view in the right panel (Files, Terminal, Diff). The launcher and
// tab strip are driven by this registry. G5 plugs the Diff surface in by replacing the `diff` entry's `Component`
// (edit `DiffPlaceholder` below, or call `registerSurface` with the same id).

import { LAYOUT } from '@shared/constants';
import type { Id } from '@shared/types';
import type { ComponentType, ReactNode } from 'react';
import { FilesSurface } from '../files/FilesSurface';
import { DiffIcon, FilesIcon, TerminalIcon } from './icons';

export type SurfaceId = 'files' | 'terminal' | 'diff';

export interface SurfaceContext {
  chatId: Id;
  /** `null` for a chat without a project. */
  projectId: Id | null;
  /** The chat has pending or applied edits (`chatChanges` query). */
  hasChanges: boolean;
}

export interface SurfaceProps {
  chatId: Id;
  projectId: Id | null;
  /**
   * What the last `openPanelSurface(chatId, id, params)` passed (`{}` if nothing). A new object per call, so an
   * effect keyed on it re-runs when the same file is opened again.
   */
  params: unknown;
  /** Current measured panel width in px (0 before the first measurement). Split needs `>= LAYOUT.splitMin`. */
  panelWidth: number;
  /** Ask for a different panel width (`LAYOUT.panelDiff` / `panelDiffSplit`), or `null` for the default. */
  setWidth(px: number | null): void;
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
  /** Default panel width. */
  width: number;
  /** Absent = cannot be opened (Terminal). */
  Component?: ComponentType<SurfaceProps>;
}

function DiffPlaceholder() {
  return <p className="m-4 text-[13px] text-text-muted">Review changes is coming soon.</p>;
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
        : { enabled: false, hint: 'Only for chats in a project' },
    tab: 'pinned',
    width: LAYOUT.panelFiles,
    Component: FilesSurface,
  },
  {
    id: 'terminal',
    label: 'Terminal',
    key: 'T',
    icon: <TerminalIcon />,
    availability: () => ({ enabled: false, hint: 'Not available yet' }),
    tab: 'opened',
    width: LAYOUT.panelFiles,
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
    width: LAYOUT.panelDiff,
    Component: DiffPlaceholder,
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
