import { describe, expect, it } from 'vitest';
import { readSSE } from './sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of readSSE(body)) out.push(d);
  return out;
}

describe('readSSE', () => {
  it('yields each frame data and skips comments', async () => {
    const body = streamOf([': OPENROUTER PROCESSING\n\n', 'data: {"a":1}\n\n', 'data: [DONE]\n\n']);
    expect(await collect(body)).toEqual(['{"a":1}', '[DONE]']);
  });

  it('handles frames split across chunks, including inside multi-byte characters', async () => {
    const bytes = new TextEncoder().encode('data: {"t":"héllo"}\n\ndata: two\n\n');
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    });
    expect(await collect(body)).toEqual(['{"t":"héllo"}', 'two']);
  });

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode('data: x\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _ of readSSE(body)) break;
    // Cancellation travels back through the pipe chain asynchronously.
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });
});
