// The terminal dock (terminal plan §5, T3.2 and T3.4): a strip at the bottom of the chat column, exactly as wide as the
// chat, with a 32 px header, xterm below it, and a drag handle on the top edge. Height lives in `terminal-store.ts`.
//
// The dock never owns the shell. It mounts an xterm instance for the chat and disposes it on unmount; the session in
// main keeps running until End (`close`) or the chat is deleted.

import { useChats, useProjects } from '@renderer/app/queries';
import { Button, IconButton } from '@renderer/components/ui';
import { TERMINAL, type TerminalBridge, type TerminalInfo } from '@shared/terminal';
import type { Id } from '@shared/types';
import { ChevronDown, MessageSquarePlus, Power } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { focusComposer } from '../composer/focus';
import { insertComposerText } from '../composer/text-sink';
import { getTerminalBridge } from './bridge';
import { terminalSelectionBlock } from './selection';
import { clampDockHeight, maxDockHeight, useTerminalUiStore } from './terminal-store';
import { useTerminal } from './use-terminal';

/** "Shell exited with code 1." (or the signal, or neither). */
export function exitLabel(info: TerminalInfo | null): string {
  if (info?.status.state !== 'exited') return 'Shell exited.';
  const { exitCode, signal } = info.status;
  if (exitCode !== null) return `Shell exited with code ${exitCode}.`;
  if (signal !== null) return `Shell exited on signal ${signal}.`;
  return 'Shell exited.';
}

export function TerminalDock({ chatId }: { chatId: Id }) {
  const bridge = getTerminalBridge();
  const storedHeight = useTerminalUiStore((s) => s.dockHeight);
  const setDockHeight = useTerminalUiStore((s) => s.setDockHeight);
  const commitDockHeight = useTerminalUiStore((s) => s.commitDockHeight);

  const chats = useChats();
  const projects = useProjects();
  // `undefined` while either list is loading: opening a project chat's shell in the home folder by mistake would keep
  // the wrong folder for the life of the session, so the dock waits for the folder instead.
  const projectId = chats.data === undefined ? undefined : (chats.data.find((c) => c.id === chatId)?.projectId ?? null);
  const cwd =
    projectId === undefined || projectId === null
      ? null
      : (projects.data?.find((p) => p.id === projectId)?.rootPath ?? null);
  const ready = projectId !== undefined && (projectId === null || projects.data !== undefined);

  const [viewport, setViewport] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewport(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const height = clampDockHeight(storedHeight, viewport);
  const maxHeight = maxDockHeight(viewport);

  const [dragging, setDragging] = useState(false);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const onResizeStart = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag.current?.();
    const startY = event.clientY;
    const startHeight = height;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const next = Math.min(
        maxHeight,
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
      setDockHeight(Math.min(maxHeight, height + step));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setDockHeight(height - step);
    }
  };

  // Without the preload bridge there is no shell to show (the web build, or Electron before T1 lands).
  if (!bridge) return null;

  return (
    <section
      data-terminal-dock=""
      aria-label="Terminal"
      className="relative flex shrink-0 flex-col border-t border-border bg-sidebar"
      style={{ height }}
    >
      <hr
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        aria-valuenow={height}
        aria-valuemin={TERMINAL.dockMinHeight}
        aria-valuemax={maxHeight}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
        className="absolute top-0 left-0 z-20 m-0 h-1.5 w-full cursor-row-resize touch-none border-0 bg-transparent hover:bg-border-control focus-visible:bg-border-control"
      />
      {ready ? (
        <TerminalPanel chatId={chatId} cwd={cwd} bridge={bridge} />
      ) : (
        <div className="min-h-0 flex-1" aria-busy="true" />
      )}
    </section>
  );
}

function TerminalPanel({ chatId, cwd, bridge }: { chatId: Id; cwd: string | null; bridge: TerminalBridge }) {
  const terminal = useTerminal(chatId, { cwd, bridge });
  const closeDock = useTerminalUiStore((s) => s.closeDock);
  const { phase, info, error, hasSelection, containerRef } = terminal;

  // Opening the dock puts the cursor in the terminal. A chat switch also mounts the dock, and that must not pull focus
  // away from the chat's composer: only a real open (`openDock`) asks for focus.
  useEffect(() => {
    if (useTerminalUiStore.getState().consumeFocusRequest(chatId)) terminal.focus();
  }, [chatId, terminal.focus]);

  const hide = () => {
    closeDock(chatId);
    focusComposer();
  };
  const end = () => {
    closeDock(chatId);
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
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border-header px-2.5">
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
          <p role="alert" className="m-0 shrink-0 px-3 py-1.5 text-[12.5px] text-danger">
            {error}
          </p>
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
