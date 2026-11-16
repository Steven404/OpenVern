// One chat's terminal in the dock (terminal plan T3.2).
//
// The registry owns the emulator and subscriptions. This hook only mounts its element and observes UI state.

import type { TerminalBridge, TerminalInfo } from '@shared/terminal';
import type { Id } from '@shared/types';
import type { Terminal } from '@xterm/xterm';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { getTerminalBridge } from './bridge';
import { terminalRegistry } from './registry';

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
  notice: string | null;
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

export { splitTerminalWrite } from './write';

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
  const [notice, setNotice] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // `attempt` triggers another attach; only Restart replaces an exited emulator.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a trigger, not a value read inside
  useEffect(() => {
    const host = containerRef.current;
    const bridge = bridgeOverride !== undefined ? bridgeOverride : getTerminalBridge();
    if (!host || !bridge) return;

    const restart = restartRequested.current;
    restartRequested.current = false;

    let disposed = false;
    let detach: (() => void) | undefined;
    let off: (() => void) | undefined;
    setPhase('opening');
    setInfo(null);
    setHasSelection(false);
    setError(null);
    setNotice(null);
    void terminalRegistry
      .attach(chatId, bridge, { cwd, restart, host })
      .then((entry) => {
        if (disposed) return;
        termRef.current = entry.term;
        detach = entry.mount(host);
        const update = () => {
          setNotice(entry.notice);
          setInfo(entry.info);
          setPhase(entry.info.status.state);
          setHasSelection(entry.term.hasSelection());
        };
        off = entry.subscribe(update);
        update();
        if (pendingFocus.current) {
          pendingFocus.current = false;
          entry.term.focus();
        }
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setPhase('error');
          setError(terminalErrorMessage(err));
        }
      });
    return () => {
      disposed = true;
      off?.();
      detach?.();
      termRef.current = null;
    };
  }, [chatId, cwd, attempt, bridgeOverride]);

  const focus = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      pendingFocus.current = true;
      return;
    }
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
    notice,
    focus,
    getSelection,
    clearSelection,
    restart,
    retry,
  };
}
