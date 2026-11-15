// Terminal read broker (terminal plan §3, §4.3, T2.1). The PTY lives in Electron main, which the backend cannot reach
// in dev, so a read is relayed: `request` emits `terminal_read_request` on the run's stream, the renderer reads main
// over IPC and posts the answer to `POST /chats/:id/terminal-reads/:requestId`, which calls `answer`.
//
// Every request settles exactly once, by the answer, the run's abort or the timeout, and settling always removes
// its entry, so nothing waits forever and nothing is left behind. Request ids are random UUIDs (not guessable from
// another chat), and an answer is accepted only under the chat the request was issued for.

import { TERMINAL, type TerminalReadAnswer, type TerminalReadRequest } from '@shared/terminal';
import type { Id } from '@shared/types';
import type { TerminalReadBroker } from '../types';

const UNAVAILABLE: TerminalReadAnswer = { ok: false, reason: 'unavailable' };

export interface TerminalReadBrokerOptions {
  /** How long a request waits for its answer. Default `TERMINAL.readTimeoutMs`. */
  timeoutMs?: number;
}

export interface TerminalReadBrokerImpl extends TerminalReadBroker {
  /** Requests still waiting (for tests and diagnostics). */
  pendingCount(): number;
}

interface Pending {
  chatId: Id;
  settle(answer: TerminalReadAnswer): void;
}

export function createTerminalReadBroker(opts: TerminalReadBrokerOptions = {}): TerminalReadBrokerImpl {
  const timeoutMs = opts.timeoutMs ?? TERMINAL.readTimeoutMs;
  /** By request id. The chat id is checked on answer. */
  const pending = new Map<Id, Pending>();

  // Not `async`, and the emit is never awaited: the answer, the abort and the timeout must settle the request even
  // when the emit's promise never does (a stalled stream). An emit that throws or rejects settles it as unavailable.
  function request(
    chatId: Id,
    req: TerminalReadRequest,
    { emit, signal }: Parameters<TerminalReadBroker['request']>[2],
  ): Promise<TerminalReadAnswer> {
    if (signal.aborted) return Promise.resolve(UNAVAILABLE);
    const requestId = crypto.randomUUID();

    let resolve!: (answer: TerminalReadAnswer) => void;
    const answered = new Promise<TerminalReadAnswer>((r) => {
      resolve = r;
    });
    let settled = false;
    const settle = (answer: TerminalReadAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pending.delete(requestId);
      resolve(answer);
    };
    const onAbort = () => settle(UNAVAILABLE);
    const timer = setTimeout(() => settle(UNAVAILABLE), timeoutMs);
    // A waiting read alone must not keep the process alive. While a run waits, its stream (and in the app, the
    // Electron main loop) does, so the timeout still fires.
    if (typeof timer === 'object' && typeof timer?.unref === 'function') timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });

    // Registered before the event goes out: the renderer may answer before the stream write finishes.
    pending.set(requestId, { chatId, settle });
    const event = {
      type: 'terminal_read_request',
      requestId,
      request: {
        ...(req.startLine !== undefined ? { startLine: req.startLine } : {}),
        ...(req.count !== undefined ? { count: req.count } : {}),
      },
    } as const;
    try {
      const sent = emit(event);
      // `emit` must not fail; if it does, nobody will see the request.
      if (sent && typeof sent.then === 'function') sent.then(undefined, () => settle(UNAVAILABLE));
    } catch {
      settle(UNAVAILABLE);
    }
    return answered;
  }

  function answer(chatId: Id, requestId: Id, value: TerminalReadAnswer): boolean {
    const entry = pending.get(requestId);
    // Another chat's request id is refused without touching the waiter, as if it were unknown.
    if (!entry || entry.chatId !== chatId) return false;
    entry.settle(value);
    return true;
  }

  return { request, answer, pendingCount: () => pending.size };
}
