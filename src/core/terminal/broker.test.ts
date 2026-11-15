// Terminal read broker (terminal plan §4.3, T2.1): one answer per request, the run's abort and the timeout settle it
// too, and every path removes the waiter. The relay is the only way the tool reaches the user's terminal, so a stuck
// or leaked waiter would hold a run open forever.

import type { AgentEvent } from '@shared/events';
import { TERMINAL, type TerminalReadAnswer, type TerminalReadRequest } from '@shared/terminal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalReadBroker, type TerminalReadBrokerImpl } from './broker';

const CHAT = 'chat-1';
const OTHER_CHAT = 'chat-2';
const UNAVAILABLE: TerminalReadAnswer = { ok: false, reason: 'unavailable' };
const ANSWER: TerminalReadAnswer = { ok: false, reason: 'no_terminal' };

interface Started {
  promise: Promise<TerminalReadAnswer>;
  events: AgentEvent[];
  /** The id of the emitted `terminal_read_request` (set synchronously by `request`). */
  requestId(): string;
}

function start(
  broker: TerminalReadBrokerImpl,
  opts: {
    chatId?: string;
    request?: TerminalReadRequest;
    signal?: AbortSignal;
    emit?: (event: AgentEvent) => void | Promise<void>;
  } = {},
): Started {
  const events: AgentEvent[] = [];
  const promise = broker.request(opts.chatId ?? CHAT, opts.request ?? {}, {
    emit:
      opts.emit ??
      ((event) => {
        events.push(event);
      }),
    signal: opts.signal ?? new AbortController().signal,
  });
  return {
    promise,
    events,
    requestId() {
      const event = events.find((e) => e.type === 'terminal_read_request');
      if (event?.type !== 'terminal_read_request') throw new Error('no terminal_read_request was emitted');
      return event.requestId;
    },
  };
}

describe('TerminalReadBroker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits terminal_read_request and resolves with the answer', async () => {
    const broker = createTerminalReadBroker();
    const started = start(broker, { request: { startLine: 4, count: 20 } });

    expect(started.events).toHaveLength(1);
    expect(started.events[0]).toEqual({
      type: 'terminal_read_request',
      requestId: expect.any(String),
      request: { startLine: 4, count: 20 },
    });
    expect(started.requestId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(broker.pendingCount()).toBe(1);

    expect(broker.answer(CHAT, started.requestId(), ANSWER)).toBe(true);
    await expect(started.promise).resolves.toEqual(ANSWER);
    expect(broker.pendingCount()).toBe(0);
  });

  it.each([
    ['omitted', {}, {}],
    ['present', { startLine: 3 }, { startLine: 3 }],
  ])('passes the request through untouched when %s', async (_name, request, expected) => {
    const broker = createTerminalReadBroker();
    const started = start(broker, { request });
    const event = started.events[0];
    expect(event?.type === 'terminal_read_request' && event.request).toEqual(expected);
    broker.answer(CHAT, started.requestId(), ANSWER);
    await started.promise;
  });

  it('the timeout resolves to unavailable and removes the waiter', async () => {
    vi.useFakeTimers();
    const broker = createTerminalReadBroker();
    const started = start(broker);
    expect(broker.pendingCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(TERMINAL.readTimeoutMs - 1);
    expect(broker.pendingCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(started.promise).resolves.toEqual(UNAVAILABLE);
    expect(broker.pendingCount()).toBe(0);
    // A late answer from a renderer that lost the race is refused.
    expect(broker.answer(CHAT, started.requestId(), ANSWER)).toBe(false);
  });

  it('the run abort resolves to unavailable and removes the waiter', async () => {
    const broker = createTerminalReadBroker();
    const controller = new AbortController();
    const started = start(broker, { signal: controller.signal });
    expect(broker.pendingCount()).toBe(1);

    controller.abort();
    await expect(started.promise).resolves.toEqual(UNAVAILABLE);
    expect(broker.pendingCount()).toBe(0);
    expect(broker.answer(CHAT, started.requestId(), ANSWER)).toBe(false);
  });

  it('a signal that is already aborted answers unavailable without emitting anything', async () => {
    const broker = createTerminalReadBroker();
    const started = start(broker, { signal: AbortSignal.abort() });
    await expect(started.promise).resolves.toEqual(UNAVAILABLE);
    expect(started.events).toEqual([]);
    expect(broker.pendingCount()).toBe(0);
  });

  it('an unknown request id returns false and leaves nothing behind', async () => {
    const broker = createTerminalReadBroker();
    expect(broker.answer(CHAT, crypto.randomUUID(), ANSWER)).toBe(false);
    expect(broker.pendingCount()).toBe(0);
  });

  it('one answer per request: the second returns false and keeps the first', async () => {
    const broker = createTerminalReadBroker();
    const started = start(broker);
    const id = started.requestId();

    expect(broker.answer(CHAT, id, ANSWER)).toBe(true);
    expect(broker.answer(CHAT, id, UNAVAILABLE)).toBe(false);
    await expect(started.promise).resolves.toEqual(ANSWER);
    expect(broker.pendingCount()).toBe(0);
  });

  it("an answer under another chat's id is refused and the real waiter keeps waiting", async () => {
    const broker = createTerminalReadBroker();
    const started = start(broker, { chatId: CHAT });
    const id = started.requestId();

    expect(broker.answer(OTHER_CHAT, id, ANSWER)).toBe(false);
    expect(broker.pendingCount()).toBe(1);

    expect(broker.answer(CHAT, id, ANSWER)).toBe(true);
    await expect(started.promise).resolves.toEqual(ANSWER);
    expect(broker.pendingCount()).toBe(0);
  });

  it('keeps requests from different chats apart', async () => {
    const broker = createTerminalReadBroker();
    const first = start(broker, { chatId: CHAT });
    const second = start(broker, { chatId: OTHER_CHAT });
    expect(first.requestId()).not.toBe(second.requestId());
    expect(broker.pendingCount()).toBe(2);

    expect(broker.answer(OTHER_CHAT, second.requestId(), ANSWER)).toBe(true);
    await expect(second.promise).resolves.toEqual(ANSWER);
    expect(broker.pendingCount()).toBe(1);

    expect(broker.answer(CHAT, first.requestId(), UNAVAILABLE)).toBe(true);
    await expect(first.promise).resolves.toEqual(UNAVAILABLE);
    expect(broker.pendingCount()).toBe(0);
  });

  it('an emit that throws resolves to unavailable and removes the waiter', async () => {
    const broker = createTerminalReadBroker();
    const started = start(broker, {
      emit: () => {
        throw new Error('socket closed');
      },
    });

    await expect(started.promise).resolves.toEqual(UNAVAILABLE);
    expect(broker.pendingCount()).toBe(0);
  });

  it('an emit that rejects resolves to unavailable and removes the waiter', async () => {
    const broker = createTerminalReadBroker();
    const started = start(broker, { emit: async () => Promise.reject(new Error('stream gone')) });

    await expect(started.promise).resolves.toEqual(UNAVAILABLE);
    expect(broker.pendingCount()).toBe(0);
  });
});
