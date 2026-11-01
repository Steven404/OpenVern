// Streaming helper for `/chats/:id/messages` and `/chats/:id/retry` (plan §4.4, §10).
//
// Wire format: `data: <JSON AgentEvent>\n\n`, no `event:` field. Comment frames (`: ok`, `: keepalive`) are
// ignored by `readSSE` and keep the connection alive during long tool runs.
//
// Disconnect = stop. In Node (dev) `c.req.raw.signal` fires on disconnect; in Electron's `protocol.handle` it does
// NOT (plan §10) — only the response stream's `cancel()` does, which Hono surfaces as `stream.onAbort`. We hook
// both; the abort is idempotent. A request signal that is ALREADY aborted (the client left during the route's
// pre-stream validation) never fires its listener, so it counts as a disconnect too and the run never starts.

import type { AgentEvent } from '@shared/events';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Core, RunTurnInput } from '../core/types';

export const KEEPALIVE_MS = 15_000;

export interface StreamTurnInput {
  chatId: string;
  model: string;
  newUserMessage?: RunTurnInput['newUserMessage'];
  /** Called as soon as `agent.runTurn` has registered the run (or the stream gave up), to drop the pre-run claim. */
  release: () => void;
}

export function streamTurn(c: Context, core: Core, input: StreamTurnInput): Response {
  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const requestSignal = c.req.raw.signal;
    stream.onAbort(abort);
    requestSignal.addEventListener('abort', abort, { once: true });
    if (requestSignal.aborted) abort(); // fired during pre-stream validation; the listener above never will
    const keepalive = setInterval(() => {
      void stream.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    keepalive.unref?.();

    try {
      if (controller.signal.aborted) return; // client already gone: write nothing, start nothing
      await stream.write(': ok\n\n');
      if (stream.aborted || controller.signal.aborted) return; // client left before anything happened
      const run = core.agent.runTurn({
        chatId: input.chatId,
        newUserMessage: input.newUserMessage,
        model: input.model,
        signal: controller.signal,
        emit: async (event: AgentEvent) => {
          await stream.writeSSE({ data: JSON.stringify(event) });
        },
      });
      input.release(); // runTurn registers the run synchronously, so `isRunning` now guards the chat
      await run;
    } finally {
      input.release();
      clearInterval(keepalive);
      requestSignal.removeEventListener('abort', abort);
    }
  });
}
