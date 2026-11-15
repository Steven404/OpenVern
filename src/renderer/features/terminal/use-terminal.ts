// One chat's terminal in the dock (terminal plan T3.2).
//
// Main owns the shell: `open` creates the chat's session or attaches to the one still running, and returns a snapshot
// plus the sequence number it covers. The hook writes the snapshot and drops data events at or below that number, so a
// hidden-and-shown dock (or a reloaded window) shows the output once. Unmounting disposes the xterm instance only; the
// session keeps running until `close` (End, or the chat is deleted).

import {
  TERMINAL,
  type TerminalBridge,
  type TerminalDataEvent,
  type TerminalInfo,
  type TerminalStatus,
} from '@shared/terminal';
import type { Id } from '@shared/types';
import type { Terminal } from '@xterm/xterm';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { getTerminalBridge } from './bridge';
import { createFitAddon, createTerminal, TERMINAL_DOCK_PADDING, waitForTerminalFont } from './xterm';

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
  /** Opens the chat's session again, replacing an exited one with a fresh shell (the Restart button). */
  restart(): void;
  /** Tries `open` again after a failure, without replacing an existing session. */
  retry(): void;
}

/** UTF-8 size of one code point (a lone surrogate is encoded as the replacement character, 3 bytes). */
function utf8Length(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Splits one xterm `onData` payload (a paste arrives as a single large string) into pieces main accepts. Iteration is
 * by code point, so a surrogate pair or a multi-byte character is never cut in half. Order is preserved.
 */
export function splitTerminalWrite(data: string, maxBytes = TERMINAL.writeMaxBytes): string[] {
  if (data === '') return [];
  const limit = Math.max(1, Math.floor(maxBytes));
  const pieces: string[] = [];
  let piece = '';
  let bytes = 0;
  for (const char of data) {
    const size = utf8Length(char.codePointAt(0) ?? 0);
    if (bytes + size > limit && piece !== '') {
      pieces.push(piece);
      piece = '';
      bytes = 0;
    }
    piece += char;
    bytes += size;
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}

/** Electron prefixes a rejected `invoke` with the channel; the user should see only main's sentence. */
const IPC_ERROR_PREFIX = /^(?:Error invoking remote method '[^']*':\s*)+/;
const ERROR_NAME_PREFIX = /^(?:Error:\s*)+/;

/** A message fit to show under the dock: no IPC/Electron wrapper, never empty. */
export function terminalErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  const message = raw.replace(IPC_ERROR_PREFIX, '').replace(ERROR_NAME_PREFIX, '').trim();
  return message === '' ? "Couldn't open the terminal." : message;
}

export function useTerminal(chatId: Id, options: UseTerminalOptions): TerminalHandle {
  const { cwd, bridge: bridgeOverride } = options;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  /** Set by `focus()` before xterm opened; the start step applies it once there is a textarea. */
  const pendingFocus = useRef(false);
  /** Set by `restart()`; the next `open` asks main to replace an exited session. */
  const restartRequested = useRef(false);
  const [phase, setPhase] = useState<TerminalPhase>('opening');
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // `attempt` is the Restart / Retry counter: bumping it disposes this terminal and attaches again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a trigger, not a value read inside
  useEffect(() => {
    const host = containerRef.current;
    const bridge = bridgeOverride !== undefined ? bridgeOverride : getTerminalBridge();
    if (!host || !bridge) return;

    const restart = restartRequested.current;
    restartRequested.current = false;

    const term = createTerminal();
    const fit = createFitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    setPhase('opening');
    setInfo(null);
    setError(null);
    setHasSelection(false);

    let disposed = false;
    /** `null` until `open` resolves: events are buffered, then filtered by the snapshot's sequence number. */
    let snapshotSeq: number | null = null;
    let ready = false;
    /** An exit that arrived before `open` resolved. It wins over the status in the reply (the shell is gone). */
    let exitStatus: TerminalStatus | null = null;
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
        exitStatus = event.status;
        ready = false;
        setPhase(event.status.state === 'exited' ? 'exited' : 'running');
        setInfo((previous) => (previous ? { ...previous, status: event.status } : previous));
      }),
    );

    const inputOff = term.onData((data) => {
      if (!ready) return;
      for (const piece of splitTerminalWrite(data)) bridge.write(chatId, piece);
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

    /**
     * Starts xterm and attaches immediately. The first fit may use a fallback font; once JetBrains Mono is usable the
     * terminal is fitted again (and main resized), so rows and columns settle on the font the dock is designed for
     * without making the dock wait for a font that is missing or slow.
     */
    const start = () => {
      if (disposed) return;
      term.open(host);
      // 8 px of breathing room (plan §5). The padding belongs to xterm's own element: the fit addon measures the host
      // and subtracts the element's padding, so the columns stay right.
      if (term.element) term.element.style.padding = `${TERMINAL_DOCK_PADDING}px`;
      // A first fit gives `open` real dimensions instead of xterm's 80×24 default.
      fitNow();
      if (pendingFocus.current) {
        pendingFocus.current = false;
        term.focus();
      }
      bridge
        .open({ chatId, cwd, cols: term.cols, rows: term.rows, ...(restart ? { restart: true } : {}) })
        .then((result) => {
          if (disposed) return;
          snapshotSeq = result.seq;
          if (result.snapshot !== '') term.write(result.snapshot);
          for (const event of buffered.splice(0).sort((a, b) => a.seq - b.seq)) writeIfNew(event);
          // An exit seen while opening wins: the reply may say `running` even though the shell is already gone.
          const status = exitStatus ?? result.info.status;
          ready = status.state === 'running';
          setInfo({ ...result.info, status });
          setPhase(ready ? 'running' : 'exited');
          // The fitted size may differ from the one `open` was asked for.
          fitNow();
          if (ready) bridge.resize(chatId, term.cols, term.rows);
        })
        .catch((err: unknown) => {
          if (disposed) return;
          ready = false;
          setPhase('error');
          setError(terminalErrorMessage(err));
        });
    };
    start();
    void waitForTerminalFont().then(() => {
      if (disposed) return;
      fitNow();
      if (ready) bridge.resize(chatId, term.cols, term.rows);
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

  const focus = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    // xterm has no textarea before `open`; focus lands as soon as the start step finishes.
    if (term.element) term.focus();
    else pendingFocus.current = true;
  }, []);
  const getSelection = useCallback(() => {
    const term = termRef.current;
    return term?.hasSelection() ? term.getSelection() : null;
  }, []);
  const clearSelection = useCallback(() => {
    termRef.current?.clearSelection();
    setHasSelection(false);
  }, []);
  const restart = useCallback(() => {
    restartRequested.current = true;
    pendingFocus.current = true;
    setAttempt((n) => n + 1);
  }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    containerRef,
    phase,
    info,
    error,
    hasSelection,
    focus,
    getSelection,
    clearSelection,
    restart,
    retry,
  };
}
