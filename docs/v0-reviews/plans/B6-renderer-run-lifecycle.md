# B6 — Renderer run lifecycle (S0-N3, S7-N1, S7-N3)

Files: `src/renderer/lib/mock-api-client.ts` (`run`, stream path only), `stores/runs.ts`, `features/conversation/{turns.ts,Conversation.tsx,ToolCallRow.tsx}` and their tests, plus `Composer.test.tsx`. No `src/core` or `src/shared` changes. Order: S0-N3, then S7-N1, then S7-N3.

## Settled design
- **S0-N3 (mock = real server + `HttpApiClient` on Stop).** After abort the mock yields **nothing** more and the iterator rejects with `signal.reason` (a `DOMException` `AbortError`), like `http-api-client.ts:44`. What it stores mirrors `src/core/agent/loop.ts:203-263`, `:279-308`:
  - Abort during text (or right after the last delta): push the assistant with the text so far, `status:'stopped'`, `toolCalls: []`, no `usage` (loop.ts:229-233).
  - Abort during or after a tool: the assistant is already pushed as `complete` with its `toolCalls`. The current call **and every later call of that step** get a tool message `{ok:false, output: INTERRUPTED_OUTPUT, summary:'Interrupted', durationMs: elapsed}` (loop.ts:79-81, 282, 308). No next step, so no empty stopped assistant.
  - Either way: set `chat.updatedAt = now()`, leave the title alone (the server only titles a `completed` run, loop.ts:335) and don't set `chat.model`. Then `throw signal.reason`.
  - The renderer doesn't import `@core`. Add `const INTERRUPTED_OUTPUT = 'Interrupted: the run was stopped before this tool finished.';` to the mock, with a comment saying it must match `src/core/agent/history.ts:16`.
- **S7-N1.** After settle, a run that ended by abort (`run.stopped && !run.sawDone`) keeps `{...run, status:'idle', messages: keepMessages ? run.messages : [], streamingId:null, runningToolIds:[]}`. `stopped` stays `true`. `!sawDone` skips a Stop that arrived after `done` (line 271 marks it stopped anyway). `start()` overwrites the entry on the next send or retry, and `retry`'s unsent branch deletes it, so no new clearing code is needed. `dismissError` is unchanged (it only acts on `error`).
  - Send stays enabled: `ReplyComposer.tsx:41-42` only reads `status === 'running' | 'settling'`. `NewChatScreen` doesn't read `runs`.
  - Conversation already shows "Stopped" and Retry for the last turn: `turnStopped = isLast && !!run?.stopped` (Conversation.tsx:112), `onRetry` when `!active` (l.132), and `hasStoppedBlock` (AssistantTurn.tsx:37) prevents a double label after a text stop.
  - Navigation and refetch keep the flag, the same way the `error` entry survives today. It only labels the last turn, and only send or retry can change that turn.
- **S7-N3.** `export type ToolState = 'queued' | 'running' | 'ok' | 'failed' | 'skipped'`. `TurnOptions` gets a **required** `runningToolIds: readonly string[]` (so tsc flags every caller). In `buildTurns`, state is `result ? (ok ? 'ok' : 'failed') : !active ? 'skipped' : runningToolIds.includes(call.id) ? 'running' : 'queued'`. In `isWaiting`, a `queued` tool also returns `false`, like `running`, so "Thinking…" doesn't flash between tools.

## Tests first (each fails today)
1. `mock-api-client.test.ts`: add a helper `collectUntil(iter, ctrl, pred)`. It pushes events, calls `ctrl.abort()` when `pred(ev)` is true, and returns `{events, error}` (it catches the rejection).
   - `'Stop during text rejects with AbortError and saves the partial reply as stopped'`: loose chat, `delayMs:0`, abort on the first `text_delta`. Expect `error.name === 'AbortError'`, last event `text_delta` (no `assistant_end`/`done`), stored roles `['user','assistant']`, and the last message is `{status:'stopped', text:<first delta>, toolCalls:[]}`. Today the iterator ends normally with `assistant_end` and `done`.
   - `'Stop during a tool rejects and records an Interrupted result, with no extra assistant'`: project chat, abort on `tool_call`. Expect `AbortError`, last event `tool_call`, stored roles `['user','assistant','tool']`, assistant `status:'complete'` with 1 tool call, tool `{ok:false, summary:'Interrupted', output:'Interrupted: the run was stopped before this tool finished.'}`, and title still `NEW_CHAT_TITLE`. Today the pause ignores the signal: ok result, then an empty stopped assistant, then `done`.
2. `runs.test.ts`:
   - Update `'stop aborts the stream…'` (l.182-196). Replace `toBeUndefined()` with `toMatchObject({status:'idle', stopped:true, messages:[], error:null})`. This is stronger, not weaker.
   - New `'stop during a tool run keeps a stopped entry after settle'`: project chat, `delayMs:0`. Use `useRunsStore.subscribe(s => { if (s.runs[id]?.runningToolIds.length) s.stop(id) })` (unsubscribe after). Expect the same `toMatchObject`, and the cached chat ends on a tool message with `ok:false`. Today the entry is deleted.
3. `Composer.test.tsx`: new `'stop during a tool run shows Stopped with Retry and keeps Send enabled'`. Render `Conversation` + `ReplyComposer` on the seeded project chat (`delayMs:5`). Send, wait until the last `tool-row` has `data-state="running"`, click Stop. Wait for `runs[id]?.status === 'idle'`. Expect one `stopped-label` and a `Retry` button. Then `type('next')` and expect `sendButton().disabled` to be false. Today there is no label and no Retry.
4. `Conversation.test.tsx`:
   - The `buildTurns` test at l.72 adds `runningToolIds: []`.
   - New `'only the call with a tool_call event is running; the rest are queued'`: an assistant with calls c1-c3. `{active:true, runningToolIds:['c1']}` gives `['running','queued','queued']`. Adding a c1 result with `['c2']` gives `['ok','running','queued']`. `active:false` gives `['skipped','skipped','skipped']`. Also check `isWaiting(turns, {...createRun(1)})` is `false` when there are only queued calls. Today all three are `running`.
   - `ToolCallRow` `'shows a muted queued icon without a spinner'`: `state:'queued'`. Expect no `spinner`, `getByLabelText('Queued')`, the text `queued` and `data-state="queued"`.
   - Extend the overlay test at l.217: two calls `cx` and `cy` with `runningToolIds:['cx']` give rows `running` then `queued`.

## Fix steps
1. `mock-api-client.ts` `run` (l.245-291):
   - Text catch (l.262-269): push the stopped msg, then `throw err` (that is `signal.reason`). Delete the two yields.
   - After the delta loop, add `if (signal.aborted)`, which takes the same path as the catch. Make it one local `stopText()` helper.
   - Tool loop (l.275-291): use `await this.pause(this.delayMs * 8, signal)` in a try. On abort, for this and each remaining call, push the Interrupted tool message, bump `updatedAt`, and throw.
   - At the top of each step and before the final `chat_updated`: `if (signal.aborted)`, bump `updatedAt` and `throw signal.reason`.
   - `pause` (l.344) is already correct.
2. `runs.ts` `settle` (l.234-245): `const keepStopped = run.stopped && !run.sawDone;`. Delete only if `!keepMessages && !run.error && !keepStopped`. The kept entry also resets `streamingId:null, runningToolIds:[]`. Update the `RunState.stopped` JSDoc (l.36) to say it is kept until the next send or retry, like `error`.
3. `turns.ts`: `ToolState` (l.8), the `ToolBlock.state` doc (l.26: add "`queued`: run open, no `tool_call` yet"), `TurnOptions` (l.40-44), destructure and use it at l.57 and l.93, `isWaiting` l.106 (`b.state === 'running' || b.state === 'queued'`).
4. `Conversation.tsx:32-35`: pass `runningToolIds: run?.runningToolIds ?? []` and add `run?.runningToolIds` to the memo deps.
5. `ToolCallRow.tsx`:
   - `ToolStateIcon` (l.80): `queued`, so `<Clock aria-label="Queued" size={16} strokeWidth={2} className="shrink-0 text-text-faint" />`, imported from lucide.
   - Trailing label (l.55-59): `queued` gets `<span className="font-mono text-[11.5px] text-text-faint">queued</span>`, the same style as "not run".
   - Output text (l.71): `queued` gives `'Waiting to run.'`.
   - Update the doc comment (l.32).
   - Use only the existing tokens (`text-text-faint`). No new CSS.

## Risks
- Other tests on the mock:
  - `Composer.test.tsx:97-121` uses `waitForIdle` (`runs[id]` undefined), which never happens after Stop now. Wait for `status === 'idle' && stopped` instead and keep every other assertion.
  - Its `messages.at(-1)` `status:'stopped'` assumes a text stop. If it is flaky now that tool stops are real, wait for a `text_delta` before clicking Stop, but don't loosen the assertion.
  - `NewChatScreen.test.tsx:138,168` and the other `waitForIdle` callers never Stop, so they are unaffected. `Sidebar.test.tsx` doesn't use runs.
- A stopped settle polls with real timers: the first sleep is 250 ms. The new store and Composer tests take about 0.3 s each. That is fine, don't add fake timers.
- On the real server the gap between `assistant_end` and the first `tool_call` is tiny, so the queued icon shows only briefly. The mock (`delayMs*8`) makes it visible.

## Blocked
None. Defaults taken (INDEX decisions):
- Queued is a muted Clock with no spinner.
- The stopped flag survives navigation and refetch.
- `isWaiting` treats `queued` as busy.

## Verification
`npx vitest run`, `npm run typecheck`, `npm run lint`.
