# S5 code review findings

Reviewed branch `V0` at `ad1cf46` (same as the scoped HEAD; the S5 files have no uncommitted changes).
Model: Claude Opus 5.5, effort max.

## Summary

S5 is mostly solid. I found no way around the security middleware's X-Harness-Client, Origin or thumbnail checks, the API key never leaves the server, and every route in §4.3 exists. One major bug means S5 does not fully meet its bar yet. If the client disconnects before the stream opens, the server misses it. The run starts anyway, gets stuck, and every later Send or Retry on that chat returns 409 until the server restarts. One minor gap: on the HTTP dev server, the Host check accepts `harness`, so DNS rebinding through that single-label name is still possible. I could not run `npm test` here: this checkout's `node_modules` is stale and lacks `ignore` (S3 dependency; the lockfile has it, so `npm ci` fixes it). I checked both findings with scripts against the real `@hono/node-server`, using the same wiring as `createCore` with stub tools: `/tmp/s5-review/repro-early-disconnect.mts` and `/tmp/s5-review/host-harness.mts`.

## Findings

### [major] A disconnect before the stream opens is missed, and the chat stays stuck on 409

ID: S5-M1

Status: fixed in 40bd78a

- Location: `src/server/sse.ts:31`
- Problem: `streamTurn` listens for the request's abort event and then checks only `stream.aborted || controller.signal.aborted` (line 39). If the client disconnects while the route is still validating (before `streamSSE` runs), the request signal has already fired. A listener added to an already-aborted signal never runs. `@hono/node-server` also never cancels the response body, because its close listener is attached after the socket has already closed, so `stream.onAbort` never fires either.
  - The run starts with a live signal. It saves the user message, binds the attachments, then blocks forever on SSE backpressure at its third write.
  - `isRunning` stays true, so every later Send or Retry on that chat returns `409 conflict`. Reproduced; still stuck after 20 s.
  - Disconnecting after the headers arrive works correctly: the reply is saved as `stopped` and the next send gets 200.
- Trigger: in web dev, click Stop (available as soon as you click Send) or reload during pre-stream validation. Vite's proxy destroys the upstream request when the browser aborts.
  - For a text message the window is a few ms. Disconnecting 0–5 ms after sending reproduced it.
  - With an image attached and the 1 h model cache expired, the window is a full OpenRouter `/models` request, because `chats.ts:79` calls `core.models.get` before the stream opens.
  - In Electron the request signal never fires (§10). The S8 spike only tested aborts after the body had started, so the same failure is possible in prod but unverified.
- Why it matters: it breaks the S5.4/§4.3 rule that a client disconnect means stop. Pressing Stop saves a message the user meant to cancel and leaves the chat unusable until restart (DELETE still works, after a 5 s wait). No model call is made, so there is no cost.
- Direction: in `streamTurn`, treat an already-aborted request signal as aborted, e.g. `if (requestSignal.aborted) abort()` right after adding the listener, or check `requestSignal.aborted` in the early return. Add a test that aborts while the route is still validating (e.g. a slow `models.get` stub plus an image), then asserts `isRunning` is false and the next send returns 200.

### [minor] Dev server accepts `Host: harness` over plain HTTP, so DNS rebinding still works through that name

ID: S5-N1

Status: fixed in a4da70e

- Location: `src/server/middleware/security.ts:17`
- Problem: §3.3 allows `harness` as "the app:// host", but `HOST_RE` accepts it on any scheme. `security.test.ts:42` asserts this for HTTP.
  - A page at `http://harness:8787/` that is later rebound to 127.0.0.1 can call the API as same-origin. It can set `X-Harness-Client` with no preflight, and browsers send no Origin on same-origin GETs.
  - Verified: `GET /api/chats/:id` with `Host: harness:8787` returns 200 with the chat. The same request with `evil.com:8787` returns 403.
  - Vite on port 5173 is not a path in, because its own allowed-hosts check rejects `harness`. The attack goes straight to port 8787.
- Preconditions: web dev with the API server running; an attacker who controls how `harness` resolves (e.g. a hostile Wi‑Fi's DHCP search domain or an LLMNR responder); and a browser that does not block a rebound page from reaching loopback.
- Why it matters: the attacker can read every chat (including project file contents that tools returned), project paths, and attachment bytes. Writes are still blocked by the Origin check, and the key is never served by the API.
- Direction: accept `harness` only when `url.protocol === 'app:'`. For http/https require `localhost` or `127.0.0.1` in both the Host header and the URL. Change the `harness` case in the test to expect 403 over HTTP.

## Requirement gaps

- S5.4 / §4.3 "client disconnect on a streaming route = stop": not met when the disconnect happens before `streamSSE` runs (major finding).
- S5.8 "abort by disconnect saves stopped": only tested for disconnects after the stream has opened; nothing tests a disconnect during validation.
- S5.2 / §3.3 "Host … blocks DNS rebinding": not met for `harness` over HTTP on the dev server (minor finding).

## Checked and sound

- **Middleware order and coverage:** `security` is registered on `/api/*` before every route. Unknown `/api` paths and foreign preflights get 403, and no `Access-Control-*` header is ever sent.
- **Host check:** it covers both the Host header and the URL host. Over HTTP, node-server builds the URL only from Host or an absolute http(s) target, so an HTTP client cannot produce an `app:` URL or reach the app:// exemption.
- **Origin:** exact-match allowlist; `null` is rejected.
- **Thumbnail exemption (§10):**
  - GET only (HEAD is not exempt).
  - The pathname regex matches only the content route. Hono decodes paths with `decodeURI`, which keeps `%2F`, so an encoded path cannot route somewhere else.
  - `same-site`, `cross-site`, and a missing header over HTTP are all rejected; Host and Origin are still enforced.
  - Responses carry `nosniff`, `CORP: same-origin` and a sandbox CSP.
- **Key handling:**
  - PUT trims the key (zod), validates it with the provider before calling `setApiKey`, and returns only `PublicSettings`. PATCH and DELETE return only `PublicSettings` too.
  - JSON and zod errors never echo the input.
  - `dev.ts` logs only method, path, status and time.
  - `onError` returns a generic `internal` body and logs stacks only for unknown errors.
- **Pre-stream validation:** missing chat 404; the synchronous claim closes the check-then-run race (409); the attachment cap; an attachment owned by another chat 409; image + non-vision model 400. All return JSON before the stream opens. Retry checks that a user message exists.
- **Disconnect after the stream opens:** `onAbort` and the request signal both stop the run, and the partial reply is saved as `stopped` (verified on node-server).
- **SSE framing:** each frame is a single write; the stream opens with `: ok`, sends a keepalive every 15 s (unref'd and cleared), and closes after `done`.
- **Uploads:**
  - The body limit is checked from Content-Length, or counted while streaming when there is none, and never buffers past about 10 MB + 64 KB.
  - The file size is checked before S1 sniffs the type.
  - Download `Content-Type` comes from the sniffed mime (plus `charset` for text). DELETE removes only unbound attachments.
- **`createCore`:**
  - Uses the injected `SecretStore` and the injected provider, or OpenRouter reading `settings.getApiKey`.
  - The cache path resolves the same way as `createStorage`.
  - The agent uses the same projects service with the same `getProjectTools`/`renderTree`, so tools and the system-prompt tree use the same `rootPath`.
  - `cleanupOrphans` is awaited at startup.
- **`dev.ts`:** binds `127.0.0.1:8787`; honours `HARNESS_DATA_DIR`; uses `FileSecretStore`; supports `HARNESS_FAKE_PROVIDER=1`.
- **`DELETE /chats/:id`:** aborts the run, waits up to 5 s, then removes the chat and its attachments.
