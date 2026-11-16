// The terminal dock (terminal plan §5, T3.2 and T3.4): a strip at the bottom of the chat column, exactly as wide as the
// chat, with a 32 px header, xterm below it, and a drag handle on the top edge. Height lives in `terminal-store.ts`.
//
// The dock never owns the shell. It mounts an xterm instance for the chat and detaches it on unmount; the session in
// main keeps running until End (`close`) or the chat is deleted.

import { useChats, useProjects } from '@renderer/app/queries';
import { Button, IconButton } from '@renderer/components/ui';
import { TERMINAL, type TerminalBridge, type TerminalInfo } from '@shared/terminal';
import type { Id } from '@shared/types';
import { ChevronDown, MessageSquarePlus, Power } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { focusComposer } from '../composer/focus';
import { insertComposerText } from '../composer/text-sink';
import { getTerminalBridge } from './bridge';
import { terminalRegistry } from './registry';
import { terminalSelectionBlock } from './selection';
import { clampDockHeight, maxDockHeight, useTerminalUiStore } from './terminal-store';
import { useTerminal } from './use-terminal';
import { TERMINAL_DOCK_HEADER_HEIGHT } from './xterm';

/**
 * The conversation keeps at least this much of the chat column when the dock is asked for more than the column has.
 * The dock's own floor (`TERMINAL.dockMinHeight`) still wins when the two cannot both hold.
 */
export const DOCK_CONVERSATION_MIN_HEIGHT = 96;

/** "Shell exited with code 1." (or the signal, or neither). */
export function exitLabel(info: TerminalInfo | null): string {
  if (info?.status.state !== 'exited') return 'Shell exited.';
  const { exitCode, signal } = info.status;
  if (exitCode !== null) return `Shell exited with code ${exitCode}.`;
  if (signal !== null) return `Shell exited on signal ${signal}.`;
  return 'Shell exited.';
}

/**
 * The tallest the dock may be in the space the chat column actually has, leaving the conversation a usable height.
 * `null` before layout (jsdom, a hidden column): the caller then keeps the stored height.
 */
export function availableDockHeight(section: HTMLElement | null): number | null {
  const parent = section?.parentElement;
  if (!parent) return null;
  const columnHeight = parent.clientHeight;
  if (columnHeight <= 0) return null;

  let usedAbove = 0;
  for (const child of Array.from(parent.children)) {
    if (child === section || !(child instanceof HTMLElement)) continue;
    const style = getComputedStyle(child);
    // The sidebar's open button is absolutely positioned and takes no flow space.
    if (style.position === 'absolute' || style.position === 'fixed') continue;
    // The conversation is the one flexible child: its height is what the dock must leave room for. (Its wrapper grows;
    // every sibling the dock has to fit beside does not.)
    if (Number.parseFloat(style.flexGrow === '' ? '0' : style.flexGrow) > 0) continue;
    usedAbove += child.getBoundingClientRect().height;
  }
  return Math.max(TERMINAL.dockMinHeight, Math.floor(columnHeight - usedAbove - DOCK_CONVERSATION_MIN_HEIGHT));
}

export function TerminalDock({ chatId }: { chatId: Id }) {
  const bridge = getTerminalBridge();
  const storedHeight = useTerminalUiStore((s) => s.dockHeight);
  const setDockHeight = useTerminalUiStore((s) => s.setDockHeight);
  const commitDockHeight = useTerminalUiStore((s) => s.commitDockHeight);
  const closeDock = useTerminalUiStore((s) => s.closeDock);

  const chats = useChats();
  const projects = useProjects();
  const listed = chats.data?.find((c) => c.id === chatId);
  // A chat missing from a loaded list (a deleted chat's URL) never gets a shell. `undefined` while the list loads is
  // not the same thing: opening a project chat's shell in the home folder by mistake would last for the session.
  const chatMissing = chats.data !== undefined && listed === undefined;
  const projectId = chats.data === undefined || chatMissing ? undefined : (listed?.projectId ?? null);
  // The project list is only needed for a chat with a project.
  const needsProject = typeof projectId === 'string';
  const projectFailed = needsProject && projects.isError && projects.data === undefined;
  const ready = projectId !== undefined && (!needsProject || projects.data !== undefined);

  const sectionRef = useRef<HTMLElement | null>(null);
  const [spaceLimit, setSpaceLimit] = useState<number | null>(null);

  const [viewport, setViewport] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewport(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const height = clampDockHeight(storedHeight, viewport);
  const maxHeight = maxDockHeight(viewport);

  // The dock may be taller than the chat column has room for once the composer grows, so it shrinks against the real
  // free height, not only against 60% of the window. `flex: 0 1 <height>px` is the last-resort guard: even if a layout
  // change slips past this measurement, the dock yields before it clips its own prompt.
  useEffect(() => {
    const section = sectionRef.current;
    const parent = section?.parentElement;
    if (!parent) return;
    const update = () => setSpaceLimit(availableDockHeight(section));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    for (const child of Array.from(parent.children)) {
      if (child !== section) observer.observe(child);
    }
    return () => observer.disconnect();
  }, []);

  const heightLimit = Math.min(maxHeight, spaceLimit ?? maxHeight);
  const renderedHeight = Math.min(height, heightLimit);

  const [dragging, setDragging] = useState(false);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const onResizeStart = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag.current?.();
    const startY = event.clientY;
    // Drag what is on screen, not the stored preference the free-height clamp may have cut down.
    const startHeight = renderedHeight;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const next = Math.min(
        heightLimit,
        Math.max(TERMINAL.dockMinHeight, Math.round(startHeight + (startY - ev.clientY))),
      );
      setDockHeight(next, { persist: false });
    };
    const up = () => {
      commitDockHeight();
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
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);
  const onResizeKey = (event: ReactKeyboardEvent) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setDockHeight(Math.min(heightLimit, renderedHeight + step));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setDockHeight(renderedHeight - step);
    }
  };

  const hide = useCallback(() => {
    closeDock(chatId);
    focusComposer();
  }, [chatId, closeDock]);

  // Without the preload bridge there is no shell to show (the web build, or Electron before T1 lands).
  if (!bridge) return null;

  let body: ReactNode;
  if (chatMissing) {
    body = (
      <DockNote
        message="This chat doesn't exist or was deleted, so there is no terminal to open."
        onRetry={() => void chats.refetch()}
        onHide={hide}
      />
    );
  } else if (chats.isError && chats.data === undefined) {
    body = (
      <DockNote
        message={dockLoadError("Couldn't load your chats.", chats.error)}
        onRetry={() => void chats.refetch()}
        onHide={hide}
      />
    );
  } else if (projectFailed) {
    body = (
      <DockNote
        message={dockLoadError("Couldn't load the project folder.", projects.error)}
        onRetry={() => void projects.refetch()}
        onHide={hide}
      />
    );
  } else if (ready) {
    const cwd = projectId === null ? null : (projects.data?.find((p) => p.id === projectId)?.rootPath ?? null);
    body = <TerminalPanel chatId={chatId} cwd={cwd} bridge={bridge} />;
  } else {
    body = <DockNote message="Loading the terminal…" busy onHide={hide} />;
  }

  return (
    <section
      ref={sectionRef}
      data-terminal-dock=""
      data-dock-height={renderedHeight}
      aria-label="Terminal"
      className="relative flex flex-col border-t border-border bg-sidebar"
      style={{ flex: `0 1 ${renderedHeight}px`, minHeight: TERMINAL.dockMinHeight }}
    >
      <hr
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        aria-valuenow={renderedHeight}
        aria-valuemin={TERMINAL.dockMinHeight}
        aria-valuemax={heightLimit}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
        className="absolute top-0 left-0 z-20 m-0 h-1.5 w-full cursor-row-resize touch-none border-0 bg-transparent hover:bg-border-control focus-visible:bg-border-control"
      />
      {body}
    </section>
  );
}

function dockLoadError(fallback: string, error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? `${fallback} ${error.message.trim()}` : fallback;
}

/**
 * The dock's body when no terminal is mounted: a chat that isn't in the list, a failed list query, or the wait for
 * one. It keeps the dock's shape (header + screen area) so opening it never jumps the layout.
 */
function DockNote({
  message,
  onRetry,
  onHide,
  busy = false,
}: {
  message: string;
  onRetry?: () => void;
  onHide: () => void;
  busy?: boolean;
}) {
  return (
    <>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border-header px-2.5">
        <span className="text-[13px] font-semibold text-text-secondary">Terminal</span>
        <span className="flex-1" />
        <IconButton size="sm" aria-label="Hide terminal" tooltip="Hide terminal" onClick={onHide}>
          <ChevronDown size={15} aria-hidden="true" />
        </IconButton>
      </header>
      {busy ? (
        <div className="min-h-0 flex-1" aria-busy="true" />
      ) : (
        <div role="alert" className="flex min-h-0 flex-1 flex-wrap items-center gap-3 px-3 py-2">
          <p className="m-0 min-w-0 flex-1 text-[12.5px] text-danger">{message}</p>
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      )}
    </>
  );
}

function TerminalPanel({ chatId, cwd, bridge }: { chatId: Id; cwd: string | null; bridge: TerminalBridge }) {
  const terminal = useTerminal(chatId, { cwd, bridge });
  const closeDock = useTerminalUiStore((s) => s.closeDock);
  const focusRequested = useTerminalUiStore((s) => s.focusRequests[chatId] === true);
  const { phase, info, error, hasSelection, containerRef } = terminal;

  // Opening the dock asks for focus through the store. A chat switch mounts the dock too, and that must not pull focus
  // away from the chat's composer: only an explicit open (`openDock`) or a launcher click sets a request, and consuming
  // it here clears it. `wantsFocus` survives StrictMode's mount → unmount → mount, so the remounted xterm gets focused.
  const wantsFocus = useRef(false);
  useEffect(() => {
    if (focusRequested) {
      useTerminalUiStore.getState().consumeFocusRequest(chatId);
      wantsFocus.current = true;
    }
    if (wantsFocus.current) terminal.focus();
  }, [chatId, focusRequested, terminal.focus]);

  const hide = () => {
    closeDock(chatId);
    focusComposer();
  };
  const end = () => {
    closeDock(chatId);
    terminalRegistry.dispose(chatId);
    void bridge.close(chatId).catch(() => {});
    focusComposer();
  };
  const addSelection = () => {
    const block = terminalSelectionBlock(terminal.getSelection() ?? '');
    if (!block) return;
    if (!insertComposerText(chatId, block)) return;
    terminal.clearSelection();
    focusComposer();
  };

  return (
    <>
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border-header px-2.5"
        style={{ height: TERMINAL_DOCK_HEADER_HEIGHT }}
      >
        <span className="text-[13px] font-semibold text-text-secondary">Terminal</span>
        {info ? (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-text-faint" title={info.cwd}>
            {info.shell} · {info.cwd}
          </span>
        ) : null}
        <span className="flex-1" />
        <IconButton
          size="sm"
          aria-label="Add selection to chat"
          tooltip="Add selection to chat"
          disabled={!hasSelection}
          onClick={addSelection}
        >
          <MessageSquarePlus size={15} aria-hidden="true" />
        </IconButton>
        <IconButton size="sm" aria-label="End terminal" tooltip="End terminal" onClick={end}>
          <Power size={15} aria-hidden="true" />
        </IconButton>
        <IconButton size="sm" aria-label="Hide terminal" tooltip="Hide terminal" onClick={hide}>
          <ChevronDown size={15} aria-hidden="true" />
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-code" data-testid="terminal-screen" />
        {phase === 'error' ? (
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border-header px-3 py-1.5">
            <p role="alert" className="m-0 min-w-0 flex-1 text-[12.5px] text-danger">
              {error}
            </p>
            <Button size="sm" variant="ghost" onClick={() => terminal.retry()}>
              Retry
            </Button>
          </div>
        ) : null}
        {phase === 'exited' ? (
          <div className="flex shrink-0 items-center gap-3 border-t border-border-header px-3 py-1.5">
            <p className="m-0 text-[12.5px] text-text-faint">{exitLabel(info)}</p>
            <Button size="sm" variant="ghost" onClick={() => terminal.restart()}>
              Restart
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
