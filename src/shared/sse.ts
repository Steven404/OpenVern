import { EventSourceParserStream } from 'eventsource-parser/stream';

/**
 * Reads a `text/event-stream` body and yields each frame's `data`.
 * Comment lines (`: keepalive`) are skipped. Used by the renderer and by the OpenRouter adapter.
 */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body
    .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
    .pipeThrough(new EventSourceParserStream())
    .getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value.data;
    }
  } finally {
    // Runs on early `break`/`return` too: cancels the underlying body.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
