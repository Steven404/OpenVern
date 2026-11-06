// The right panel (plan §5.1): tab strip over one surface at a time. Mounted by AppShell next to the chat column
// while `rightPanelOpen`. Per-chat state (active surface, open tabs) lives in `panel-store.ts`.
// Width is the user's: the handle on the left edge sets it, and opening a file does not change it.

import { cx } from '@renderer/components/ui';
import { useUiStore } from '@renderer/stores/ui';
import { LAYOUT } from '@shared/constants';
import type { Id } from '@shared/types';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { FileViewer } from '../files/FileViewer';
import { FileIcon, PlusIcon, XIcon } from './icons';
import { Launcher } from './Launcher';
import { availablePanelWidth } from './layout';
import {
  type PanelTab,
  type PanelTarget,
  resetFileState,
  rootKey,
  tabKey,
  useChatPanelState,
  usePanelStore,
} from './panel-store';
import { useHasChanges, useRefreshProjectFiles } from './queries';
import { getSurface, getSurfaces, type SurfaceContext, type SurfaceId } from './surfaces';

export const RIGHT_PANEL_TOGGLE_ID = 'right-panel-toggle';

const tabBase =
  'inline-flex min-h-[30px] cursor-pointer items-center gap-[7px] rounded-[6px] border-0 text-[13px] whitespace-nowrap';
const tabOn = 'bg-surface-raised text-text';
const tabOff = 'bg-transparent text-text-muted hover:bg-overlay-tonal hover:text-text';

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function RightPanel({ chatId, projectId }: { chatId: Id; projectId: Id | null | undefined }) {
  const hasChanges = useHasChanges(chatId);
  const stored = useChatPanelState(chatId);
  const bindRoot = usePanelStore((s) => s.bindRoot);
  // File tabs are relative to the folder being listed. If it changed (project chip, chat moved out of its project),
  // show the reset state right away; the layout effect writes it back to the store.
  const root = projectId === undefined ? undefined : rootKey(projectId);
  useLayoutEffect(() => {
    if (root) bindRoot(chatId, root);
  }, [chatId, root, bindRoot]);
  const state = root && stored.root && stored.root !== root ? resetFileState(stored, root) : stored;
  const setPanelOpen = useUiStore((s) => s.setRightPanelOpen);
  const preferredWidth = useUiStore((s) => s.rightPanelWidth);
  const setPanelWidth = useUiStore((s) => s.setRightPanelWidth);
  const commitPanelWidth = useUiStore((s) => s.commitRightPanelWidth);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const show = usePanelStore((s) => s.show);
  const closeTab = usePanelStore((s) => s.closeTab);
  const openSurface = usePanelStore((s) => s.openSurface);
  useRefreshProjectFiles(chatId, projectId ?? null);

  const ctx: SurfaceContext = { chatId, projectId: projectId ?? null, hasChanges };
  const filesEnabled = getSurface('files')?.availability(ctx).enabled ?? false;

  const defaultTarget: PanelTarget = filesEnabled ? { type: 'surface', id: 'files' } : { type: 'launcher' };
  let active: PanelTarget = state.active ?? defaultTarget;
  // A disabled Files surface drops a leftover file tab back to the launcher.
  if (!filesEnabled && (active.type === 'file' || (active.type === 'surface' && active.id === 'files'))) {
    active = { type: 'launcher' };
  }

  const activeSurface = active.type === 'surface' ? getSurface(active.id) : undefined;

  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const maxWidth = availablePanelWidth(sidebarCollapsed, viewport);
  const width = Math.min(preferredWidth, maxWidth);

  const [dragging, setDragging] = useState(false);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const onResizeStart = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag.current?.();
    const startX = event.clientX;
    const startW = width;
    const max = maxWidth;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const next = Math.round(startW + (startX - ev.clientX));
      setPanelWidth(Math.min(max, Math.max(LAYOUT.panelMin, next)), { persist: false });
    };
    const up = () => {
      commitPanelWidth();
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      stopDrag.current = null;
    };
    stopDrag.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);
  const onResizeKey = (event: ReactKeyboardEvent) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setPanelWidth(Math.min(maxWidth, width + step));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setPanelWidth(width - step);
    }
  };

  const close = () => {
    setPanelOpen(false);
    document.getElementById(RIGHT_PANEL_TOGGLE_ID)?.focus();
  };
  const isActive = (t: PanelTab | PanelTarget) => tabKey(t) === tabKey(active);
  const filesTarget: PanelTarget = { type: 'surface', id: 'files' };
  const pinned = getSurfaces().filter((d) => d.tab === 'pinned' && d.Component);
  const SurfaceComponent = activeSurface?.Component;

  return (
    <aside
      id="right-panel"
      aria-label="Right panel"
      className={cx(
        'panel-in relative flex h-full min-h-0 max-w-full flex-col border-l border-border bg-sidebar motion-reduce:transition-none',
        dragging ? 'transition-none' : 'transition-[flex-basis] duration-[220ms] ease-[cubic-bezier(.16,1,.3,1)]',
      )}
      style={{ flex: `0 1 ${width}px`, width, minWidth: LAYOUT.panelMin }}
    >
      <hr
        aria-orientation="vertical"
        aria-label="Resize right panel"
        aria-valuenow={width}
        aria-valuemin={LAYOUT.panelMin}
        aria-valuemax={maxWidth}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
        className="absolute top-0 left-0 z-20 m-0 h-full w-1.5 cursor-col-resize touch-none border-0 bg-transparent hover:bg-border-control focus-visible:bg-border-control"
      />
      <header className="flex min-h-[52px] items-center gap-1.5 border-b border-border-header py-2 pr-2 pl-2.5">
        <div role="tablist" aria-label="Open panels" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {pinned.map((def) => (
            <button
              key={def.id}
              type="button"
              role="tab"
              aria-selected={isActive({ type: 'surface', id: def.id })}
              disabled={!def.availability(ctx).enabled}
              onClick={() => show(chatId, { type: 'surface', id: def.id })}
              className={cx(
                tabBase,
                'flex-none px-2.5 disabled:cursor-not-allowed disabled:opacity-60',
                isActive({ type: 'surface', id: def.id }) ? tabOn : tabOff,
              )}
            >
              {def.icon}
              {def.label}
            </button>
          ))}
          {state.tabs.map((tab) => {
            const sel = isActive(tab);
            const def = tab.type === 'surface' ? getSurface(tab.id) : undefined;
            const name = tab.type === 'file' ? baseName(tab.path) : (def?.label ?? tab.id);
            return (
              <div
                key={tabKey(tab)}
                className={cx(
                  'inline-flex flex-none items-center gap-0.5 rounded-[6px] pr-1',
                  sel ? tabOn : 'bg-transparent',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={sel}
                  title={tab.type === 'file' ? tab.path : def?.label}
                  onClick={() => show(chatId, tab)}
                  className={cx(
                    tabBase,
                    'max-w-[180px] bg-transparent pr-1 pl-2.5',
                    sel ? 'text-text' : 'text-text-muted hover:text-text',
                  )}
                >
                  {tab.type === 'file' ? (
                    <FileIcon className="flex-none" />
                  ) : (
                    <span className="flex-none [&>svg]:size-3.5">{def?.icon}</span>
                  )}
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${name}`}
                  onClick={() => closeTab(chatId, tab)}
                  className="inline-flex size-[22px] flex-none cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent text-text-muted hover:bg-overlay-tonal-hover hover:text-text"
                >
                  <XIcon />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            aria-label="Open a panel"
            aria-pressed={active.type === 'launcher'}
            onClick={() => show(chatId, { type: 'launcher' })}
            className="inline-flex size-[30px] flex-none cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent text-text-muted hover:bg-overlay-tonal hover:text-text aria-pressed:bg-overlay-tonal aria-pressed:text-text"
          >
            <PlusIcon />
          </button>
        </div>
        <button
          type="button"
          aria-label="Close panel"
          onClick={close}
          className="inline-flex size-[34px] flex-none cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent text-text-muted hover:bg-overlay-ghost hover:text-text"
        >
          <XIcon size={17} strokeWidth={1.9} />
        </button>
      </header>

      {active.type === 'launcher' ? (
        <Launcher
          ctx={ctx}
          onOpen={(id: SurfaceId) => {
            if (id === 'files') show(chatId, filesTarget);
            else openSurface(chatId, id);
          }}
        />
      ) : null}
      {active.type === 'file' ? (
        <FileViewer chatId={chatId} projectId={projectId} path={active.path} onBack={() => show(chatId, filesTarget)} />
      ) : null}
      {SurfaceComponent ? (
        <SurfaceComponent
          chatId={chatId}
          projectId={projectId}
          params={active.type === 'surface' ? (state.params[active.id] ?? {}) : {}}
        />
      ) : null}
    </aside>
  );
}
