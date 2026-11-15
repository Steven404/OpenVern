// One chat's terminal in the dock (terminal plan T3.2).
//
// Main owns the shell: `open` creates the chat's session or attaches to the one still running, and returns a snapshot
// plus the sequence number it covers. The hook writes the snapshot and drops data events at or below that number, so a
// hidden-and-shown dock (or a reloaded window) shows the output once. Unmounting disposes the xterm instance only; the
// session keeps running until `close` (End, or the chat is deleted).

import type { TerminalBridge, TerminalDataEvent, TerminalInfo } from '@shared/terminal';
import type { Id } from '@shared/types';
import type { Terminal } from '@xterm/xterm';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { getTerminalBridge } from './bridge';
import { createFitAddon, createTerminal } from './xterm';

/** Resizes are coalesced this long, so a drag of the dock's edge sends one IPC message, not twenty. */
export const RESIZE_DEBOUNCE_MS = 120;

/** `opening`: `open` is in flight · `running` · `exited` (the shell ended; Restart starts a new one) · `error`. */
export type TerminalPhase = 'opening' | 'running' | 'exited' | 'error';

export interface UseTerminalOptions {
  /** The folder the shell starts in, or `null` for home. Main stat-checks it and falls back to home. */
  cwd: string | null;
  /** Replaces `window.openvern.terminal` (tests). */
  bridge?: TerminalBridge | null;
}

export interface TerminalHandle {
  /** Give this to the dock's body element; xterm opens into it. */
  containerRef: RefObject<HTMLDivElement | null>;
  phase: TerminalPhase;
  info: TerminalInfo | null;
  /** The message shown when `phase` is `error`. */
  error: string | null;
  hasSelection: boolean;
  focus(): void;
  /** The selected text, or `null` when nothing is selected. */
  getSelection(): string | null;
  /** Drops the selection (after it was added to the composer). */
  clearSelection(): void;
  /** Disposes this terminal and opens the chat's session again (main replaces an exited session). */
  restart(): void;
}

export function useTerminal(chatId: Id, options: UseTerminalOptions): TerminalHandle {
  const { cwd, bridge: bridgeOverride } = options;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [phase, setPhase] = useState<TerminalPhase>('opening');
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // `attempt` is the Restart counter: bumping it disposes this terminal and attaches again (main replaces an exited
  // session, terminal plan T1.3).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a trigger, not a value read inside
  useEffect(() => {
    const host = containerRef.current;
    const bridge = bridgeOverride !== undefined ? bridgeOverride : getTerminalBridge();
    if (!host || !bridge) return;

    const term = createTerminal();
    const fit = createFitAddon();
    term.loadAddon(fit);
    term.open(host);
    // 8 px of breathing room (plan §5). The padding belongs to xterm's own element: the fit addon measures the host and
    // subtracts the element's padding, so the columns stay right.
    if (term.element) term.element.style.padding = '8px';
    termRef.current = term;
    setPhase('opening');
    setInfo(null);
    setError(null);
    setHasSelection(false);

    let disposed = false;
    /** `null` until `open` resolves: events are buffered, then filtered by the snapshot's sequence number. */
    let snapshotSeq: number | null = null;
    let ready = false;
    const buffered: TerminalDataEvent[] = [];
    const unsubscribe: (() => void)[] = [];

    const writeIfNew = (event: TerminalDataEvent) => {
      if (event.seq <= (snapshotSeq ?? -1)) return;
      term.write(event.data);
    };
    unsubscribe.push(
      bridge.onData((event) => {
        if (event.chatId !== chatId) return;
        if (snapshotSeq === null) buffered.push(event);
        else writeIfNew(event);
      }),
      bridge.onExit((event) => {
        if (event.chatId !== chatId) return;
        // Nothing more goes to a dead session: input, resizes and further writes wait for Restart.
        ready = false;
        setPhase(event.status.state === 'exited' ? 'exited' : 'running');
        setInfo((previous) => (previous ? { ...previous, status: event.status } : previous));
      }),
    );

    const inputOff = term.onData((data) => {
      if (ready) bridge.write(chatId, data);
    });
    const selectionOff = term.onSelectionChange(() => setHasSelection(term.hasSelection()));
    const resizeOff = term.onResize(({ cols, rows }) => {
      if (ready) bridge.resize(chatId, cols, rows);
    });

    const fitNow = () => {
      try {
        fit.fit();
      } catch {
        // The dock is display:none or mid unmount: keep the previous size.
      }
    };

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!disposed) fitNow();
      }, RESIZE_DEBOUNCE_MS);
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(host);

    // A first fit gives `open` real dimensions instead of xterm's 80×24 default.
    fitNow();
    bridge
      .open({ chatId, cwd, cols: term.cols, rows: term.rows })
      .then((result) => {
        if (disposed) return;
        snapshotSeq = result.seq;
        if (result.snapshot !== '') term.write(result.snapshot);
        for (const event of buffered.splice(0).sort((a, b) => a.seq - b.seq)) writeIfNew(event);
        ready = true;
        setInfo(result.info);
        setPhase(result.info.status.state === 'exited' ? 'exited' : 'running');
        // The fitted size may differ from the one `open` was asked for.
        fitNow();
        bridge.resize(chatId, term.cols, term.rows);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setPhase('error');
        setError(err instanceof Error && err.message !== '' ? err.message : "Couldn't open the terminal.");
      });

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer?.disconnect();
      inputOff.dispose();
      selectionOff.dispose();
      resizeOff.dispose();
      for (const off of unsubscribe) off();
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      // Deliberately no `bridge.close`: hiding the dock or switching chats keeps the shell running.
    };
  }, [chatId, cwd, attempt, bridgeOverride]);

  const focus = useCallback(() => termRef.current?.focus(), []);
  const getSelection = useCallback(() => {
    const term = termRef.current;
    return term?.hasSelection() ? term.getSelection() : null;
  }, []);
  const clearSelection = useCallback(() => {
    termRef.current?.clearSelection();
    setHasSelection(false);
  }, []);
  const restart = useCallback(() => setAttempt((n) => n + 1), []);

  return { containerRef, phase, info, error, hasSelection, focus, getSelection, clearSelection, restart };
}
