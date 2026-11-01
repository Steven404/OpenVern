# B3: Honour a disconnect that happens before the stream opens (S5-M1)

**Bug.** `streamTurn` (`src/server/sse.ts:31`) adds an `abort` listener to `c.req.raw.signal`. If the signal fired while the route was still validating (`routes/chats.ts:64-84`: `readJson`, `chats.get`, `attachments.get`, `models.get`), that listener never runs. The early return at l.39 only checks `stream.aborted || controller.signal.aborted`, so `runTurn` starts with a live signal. It persists the user message, binds the attachments, then blocks on SSE backpressure. `isRunning` stays true and every later Send or Retry gets 409.

**Repro confirmed with `app.request()`**; no real node-server listener is needed. A scratch test (since deleted) used the harness with gated `listModels`, an image attachment and `signal` passed to `h.call`. It aborted while `models.get` was pending, then opened the gate and never read the body. Result: status 200, `isRunning` true, 1 message persisted, next send **409**. `app.request` calls `app.fetch` directly, so `c.req.raw.signal` is the test's signal and an aborted signal does not reject the call. (`/tmp/s5-review` no longer exists.)

**Correct behaviour (§4.3 l.312, "disconnect = stop"; finding: "Pressing Stop saves a message the user meant to cancel").** If the client is gone before the run starts, the run never starts. No user message is persisted, the attachments stay unbound, Retry does not truncate, and the claim is released. The response is the bare `: ok` stream, which closes at once and which nobody reads.

**Claim/release check.** `release` (`chats.ts:26-36`) is once-only and runs in `streamTurn`'s `finally`, and the early `return` goes through that `finally`. So once the run is skipped, nothing leaks. An abort between the end of validation and `streamSSE` has no await in between (send: l.84→86; retry: l.97→98). It is the same case: the signal is already aborted when the callback runs, so the fix covers it. A validation throw still releases in the route's `catch` (l.80-83). Retry claims after its awaits, so an abort during retry's `readJson`/`chats.get` is also an already-aborted signal at `streamTurn`.

## 1. Failing tests first: `src/server/stream.test.ts`

Add a helper at the bottom, next to `replaceHarness`:
```ts
/** Harness whose `listModels` waits on a gate, so `models.get` (image send) stalls before `streamSSE`. */
async function gatedHarness(script: FakeScript) {
  await h.cleanup();
  let entered!: () => void; let open!: () => void;
  const reached = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { open = r; });
  h = await createHarness({ script, wrapProvider: (fake) => ({ ...fake, id: 'fake',
    listModels: async () => { entered(); await gate; return fake.listModels(); },
    validateKey: fake.validateKey, stream: fake.stream }) });
  return { reached, open };
}
```
(The new harness has no model cache, so `models.get` → `listModels`.) Add a `describe('disconnect before the stream opens (S5-M1)')` block with these tests, each with a `10_000` timeout argument:

1. `'abort during pre-stream validation: run never starts, nothing saved, next send 200'`: `const { reached, open } = await gatedHarness(slowScript)`, then create a chat, upload `PNG_BYTES`, and make `const ac = new AbortController()`. `const p = send(chat.id, { text: 'go', attachmentIds: [img.id], model: VISION }, { signal: ac.signal })`, then `await reached; ac.abort(); open(); const res = await p;`. **Do not read or cancel `res.body`**: cancelling would fire `stream.onAbort` and hide the bug. Then:
   - `await new Promise(r => setTimeout(r, 100))`, then `expect(h.core.agent.isRunning(chat.id)).toBe(false)`.
   - `expect((await h.core.chats.get(chat.id)).messages).toEqual([])`.
   - Image still unbound: `(await h.core.attachments.get(img.id)).chatId` is `null`.
   - `const next = await send(chat.id, { text: 'again', attachmentIds: [], model: VISION })`, then `expect(next.status).toBe(200)`. The skipped run never called the provider, so this send gets `slowScript`'s slow first reply. Don't collect it: run `await readUntil(next, /"reply"/); await reader.cancel(); await waitFor(() => !h.core.agent.isRunning(chat.id))`.
2. `'already-aborted signal on send: no run, no message'`: plain `replaceHarness(slowScript)`, `ac.abort()` **before** `send(...)`. Same assertions (no image needed). If `readJson` rejects on an aborted request, accept a non-200 status, but still assert not running, no messages and next send 200.
3. `'retry with an already-aborted signal: no run, no truncation'`: with the default harness, do one full send (`collectEvents`) so there are 2 messages. Then call `h.call('/api/chats/:id/retry', { method:'POST', json:{model:VISION}, signal: ac.signal })` with `ac` already aborted, and do not read it. Assert `isRunning` false, that the messages are unchanged (same ids/length), and that a normal retry afterwards returns 200.

Run them and confirm 1 and 3 (at least) fail before the fix, with `isRunning` true or 409 rather than a hang. The waits are bounded by the 100 ms sleep plus the test timeout.

## 2. Fix: `src/server/sse.ts`

In `streamTurn`, right after `requestSignal.addEventListener(...)`:
```ts
if (requestSignal.aborted) abort(); // fired during pre-stream validation; the listener above never will
```
Also short-circuit before the first write, so nothing is written for a gone client: `if (controller.signal.aborted) return;` as the first line inside `try`. Keep the existing post-`: ok` check. Update the header comment: disconnect = `stream.onAbort`, the request signal's event, **or** a request signal that was already aborted. Make no changes in `routes/chats.ts` or the agent loop. (`loop.ts:110` already handles a pre-aborted `input.signal`, but only after it has registered and persisted. The gate must be in `streamTurn`.)

## 3. Files, risks, verification

- Files: `src/server/sse.ts`, `src/server/stream.test.ts`. Optionally update the S5 notes in `docs/v0-plan.md` l.671 to "…or an already-aborted `c.req.raw.signal`".
- Risks: very small. Electron never fires the request signal (§10), so this path is a no-op there and Electron relies on `stream.onAbort` as before. Do not cancel the response body in tests 1-3, or they pass for the wrong reason.
- Verify: `npx vitest run`, `npm run typecheck`, `npm run lint`. Then set Status of S5-M1 in `docs/v0-reviews/s5-code-review-findings.MD` and the INDEX row to fixed.

## Blocked

None. §4.3 settles the product question: an early Stop discards the unsent message, and nothing is persisted.
