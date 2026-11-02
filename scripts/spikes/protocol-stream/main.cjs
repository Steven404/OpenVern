// S8.1 spike: does a ReadableStream Response from protocol.handle('app', ...) reach fetch().body.getReader()
// in the renderer incrementally? Also: does aborting the fetch cancel the stream in main?
// Run: npx electron scripts/spikes/protocol-stream/main.cjs  (add --ozone-platform=x11 if Wayland is unavailable)
//
// RESULT (Electron 45.2.1, KDE Wayland, 2026-10-31; same on --ozone-platform=x11): INCREMENTAL.
//  - 11 chunks (": open" + 10 data frames) arrive ~200 ms apart (gaps 198-201 ms) for GET and POST.
//  - Aborting the page's fetch rejects reader.read() with AbortError and fires the ReadableStream's `cancel()`
//    in main within ms; `request.signal` does NOT fire in main. A Hono `streamSSE` handler called via
//    `hono.fetch(request)` sees it through `stream.onAbort`; `c.req.raw.signal` does NOT fire either.
//    => the server's "client disconnect = stop" must hook the response stream (`onAbort`/`cancel`), not request.signal.
'use strict';
const { app, BrowserWindow, protocol } = require('electron');

const CHUNKS = 10;
const INTERVAL_MS = 200;
const HARD_TIMEOUT_MS = 20000;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const PAGE = `<!doctype html><meta charset="utf-8"><title>spike</title><body>spike</body>
<script>
const log = (o) => console.log('SPIKE ' + JSON.stringify(o));
async function readAll(url, init) {
  const t0 = performance.now();
  const res = await fetch(url, init);
  const headersAt = Math.round(performance.now() - t0);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push({ t: Math.round(performance.now() - t0), bytes: value.length, text: dec.decode(value).trim().slice(0, 30) });
  }
  return { status: res.status, headersAt, chunks: out };
}
async function abortTest(url = 'app://openvern/abort-stream') {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal, method: 'POST', headers: { 'X-OpenVern-Client': '1' }, body: '{}' });
  const reader = res.body.getReader();
  const t0 = performance.now();
  let n = 0;
  while (n < 3) { const r = await reader.read(); if (r.done) break; n++; }
  const tAbort = Math.round(performance.now() - t0);
  ctrl.abort();
  let err = null;
  try { await reader.read(); } catch (e) { err = e.name; }
  return { readBeforeAbort: n, abortAtMs: tAbort, readerErrorAfterAbort: err };
}
(async () => {
  try {
    log({ kind: 'GET stream', ...(await readAll('app://openvern/stream')) });
    log({ kind: 'POST stream', ...(await readAll('app://openvern/stream', { method: 'POST', headers: { 'X-OpenVern-Client': '1', 'content-type': 'application/json' }, body: '{"a":1}' })) });
    log({ kind: 'abort', ...(await abortTest()) });
    await new Promise((r) => setTimeout(r, 1200)); // let main observe the cancel
    log({ kind: 'hono-abort', ...(await abortTest('app://openvern/hono-stream')) });
    await new Promise((r) => setTimeout(r, 1200));
    log({ kind: 'finished' });
  } catch (e) { log({ kind: 'error', message: String(e) }); }
})();
</script>`;

const enc = new TextEncoder();

function sseStream(total, onCancel) {
  let timer;
  let i = 0;
  const started = Date.now();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(': open\n\n'));
      timer = setInterval(() => {
        i++;
        try {
          controller.enqueue(enc.encode(`data: {"n":${i}}\n\n`));
        } catch {
          clearInterval(timer);
          return;
        }
        if (i >= total) {
          clearInterval(timer);
          controller.close();
        }
      }, INTERVAL_MS);
    },
    cancel() {
      clearInterval(timer);
      onCancel?.(`stream.cancel() fired after ${Date.now() - started}ms, ${i} chunks produced`);
    },
  });
}

const results = { abortCancel: null, abortSignal: null, honoOnAbort: null, honoSignal: null };

app.whenReady().then(async () => {
  // Hono (as used by the real server) behind the same protocol handler: does streamSSE see the disconnect?
  const { Hono } = await import('hono');
  const { streamSSE } = await import('hono/streaming');
  const hono = new Hono();
  hono.post('/hono-stream', (c) => {
    c.req.raw.signal.addEventListener('abort', () => {
      results.honoSignal = 'c.req.raw.signal abort fired';
      console.log('MAIN hono c.req.raw.signal abort fired');
    });
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        results.honoOnAbort = 'stream.onAbort fired';
        console.log('MAIN hono stream.onAbort fired');
      });
      for (let i = 1; i <= 50 && !stream.aborted; i++) {
        await stream.writeSSE({ data: JSON.stringify({ n: i }) });
        await stream.sleep(INTERVAL_MS);
      }
    });
  });

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/hono-stream') return hono.fetch(request);
    if (url.pathname === '/') {
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/stream') {
      return new Response(sseStream(CHUNKS), {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    }
    if (url.pathname === '/abort-stream') {
      request.signal.addEventListener('abort', () => {
        results.abortSignal = 'request.signal abort fired';
        console.log('MAIN request.signal abort fired');
      });
      return new Response(
        sseStream(50, (msg) => {
          results.abortCancel = msg;
          console.log(`MAIN ${msg}`);
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response('not found', { status: 404 });
  });

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const timeout = setTimeout(() => {
    console.log('RESULT TIMEOUT (hard timeout hit)');
    app.exit(2);
  }, HARD_TIMEOUT_MS);

  win.webContents.on('console-message', (event) => {
    const text = event.message ?? '';
    if (!text.startsWith('SPIKE ')) return;
    const data = JSON.parse(text.slice(6));
    if (data.kind === 'finished') {
      clearTimeout(timeout);
      console.log(
        `RESULT abortCancel=${JSON.stringify(results.abortCancel)} abortSignal=${JSON.stringify(results.abortSignal)} honoOnAbort=${JSON.stringify(results.honoOnAbort)} honoSignal=${JSON.stringify(results.honoSignal)}`,
      );
      app.exit(0);
      return;
    }
    if (data.chunks) {
      const ts = data.chunks.map((c) => c.t);
      const gaps = ts.slice(1).map((t, k) => t - ts[k]);
      console.log(
        `TIMINGS ${data.kind}: status=${data.status} headersAt=${data.headersAt}ms chunks=${ts.length} t(ms)=[${ts.join(',')}] gaps(ms)=[${gaps.join(',')}]`,
      );
    } else {
      console.log(`PAGE ${JSON.stringify(data)}`);
    }
  });
  await win.loadURL('app://openvern/');
});
