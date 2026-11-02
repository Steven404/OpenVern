// The right panel (plan §5.1): tab strip over one surface at a time. Mounted by AppShell next to the chat column
// while `rightPanelOpen`. Per-chat state (active surface, open tabs) lives in `panel-store.ts`.

import { useChats } from '@renderer/app/queries';
import { cx } from '@renderer/components/ui';
import { useUiStore } from '@renderer/stores/ui';
import { LAYOUT } from '@shared/constants';
import type { Id } from '@shared/types';
import { useEffect, useRef, useState } from 'react';
import { FileViewer } from '../files/FileViewer';
import { FileIcon, PlusIcon, XIcon } from './icons';
import { Launcher } from './Launcher';
import { type PanelTab, type PanelTarget, tabKey, useChatPanelState, usePanelStore } from './panel-store';
import { useHasChanges, useRefreshProjectFiles } from './queries';
import { getSurface, getSurfaces, type SurfaceContext, type SurfaceId } from './surfaces';

export const RIGHT_PANEL_TOGGLE_ID = 'right-panel-toggle';

const tabBase =
  'inline-flex min-h-[30px] cursor-pointer items-center gap-[7px] rounded-[8px] border-0 text-[13px] whitespace-nowrap';
const tabOn = 'bg-surface-raised text-text shadow-[inset_0_0_0_1px_var(--color-border-control)]';
const tabOff = 'bg-transparent text-text-muted hover:bg-overlay-ghost hover:text-text';

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function RightPanel({ chatId }: { chatId: Id }) {
  const chats = useChats();
  const projectId = chats.data?.find((c) => c.id === chatId)?.projectId ?? null;
  const hasChanges = useHasChanges(chatId);
  const state = useChatPanelState(chatId);
  const setPanelOpen = useUiStore((s) => s.setRightPanelOpen);
  const show = usePanelStore((s) => s.show);
  const closeTab = usePanelStore((s) => s.closeTab);
  const openSurface = usePanelStore((s) => s.openSurface);
  const setWidth = usePanelStore((s) => s.setWidth);
  useRefreshProjectFiles(chatId, projectId);

  const ctx: SurfaceContext = { chatId, projectId, hasChanges };
  const filesEnabled = getSurface('files')?.availability(ctx).enabled ?? false;

  const defaultTarget: PanelTarget = filesEnabled ? { type: 'surface', id: 'files' } : { type: 'launcher' };
  let active: PanelTarget = state.active ?? defaultTarget;
  // Files and file tabs make no sense without a project (chat moved out of it): show the launcher.
  if (!filesEnabled && (active.type === 'file' || (active.type === 'surface' && active.id === 'files'))) {
    active = { type: 'launcher' };
  }

  const activeSurface = active.type === 'surface' ? getSurface(active.id) : undefined;
  const width =
    active.type === 'file'
      ? LAYOUT.panelViewer
      : active.type === 'surface'
        ? (state.widths[active.id] ?? activeSurface?.width ?? LAYOUT.panelFiles)
        : LAYOUT.panelFiles;

  // Measured width, for surfaces that need to know whether Split fits.
  const ref = useRef<HTMLElement>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setMeasured(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      ref={ref}
      id="right-panel"
      aria-label="Right panel"
      className="panel-in flex h-full min-h-0 max-w-full flex-col border-l border-border bg-sidebar transition-[flex-basis] duration-[220ms] ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none"
      style={{ flex: `0 1 ${width}px`, minWidth: LAYOUT.panelMin }}
    >
      <header className="flex min-h-[52px] items-center gap-1.5 border-b border-border-header py-2 pr-2 pl-2.5">
        <div
          role="tablist"
          aria-label="Open panels"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-color:var(--color-border-control)_transparent] [scrollbar-width:thin]"
        >
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
                  'inline-flex flex-none items-center gap-0.5 rounded-[8px] pr-1',
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
                  className="inline-flex size-[22px] flex-none cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent text-text-muted hover:bg-overlay-current hover:text-text"
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
            className="inline-flex size-[30px] flex-none cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent text-text-muted hover:bg-overlay-ghost hover:text-text aria-pressed:bg-overlay-ghost aria-pressed:text-text"
          >
            <PlusIcon />
          </button>
        </div>
        <button
          type="button"
          aria-label="Close panel"
          onClick={close}
          className="inline-flex size-[34px] flex-none cursor-pointer items-center justify-center rounded-[10px] border-0 bg-transparent text-text-muted hover:bg-overlay-ghost hover:text-text"
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
      {active.type === 'file' && projectId ? (
        <FileViewer chatId={chatId} projectId={projectId} path={active.path} onBack={() => show(chatId, filesTarget)} />
      ) : null}
      {SurfaceComponent ? (
        <SurfaceComponent
          chatId={chatId}
          projectId={projectId}
          params={active.type === 'surface' ? (state.params[active.id] ?? {}) : {}}
          panelWidth={measured}
          setWidth={(px) => active.type === 'surface' && setWidth(chatId, active.id, px)}
        />
      ) : null}
    </aside>
  );
}
