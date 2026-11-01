# S0 code review findings

Reviewed branch `V0` at `ad1cf46`.
Model: Claude Opus 5.5, effort high.

## Summary

S0 meets its acceptance bar. All the §4 contracts are in the files almost word for word: types, error codes, ERROR_DEFAULTS/ERROR_STATUS, routes and zod bodies, events, constants, `readSSE`, Provider, Tool, ApiClient, and the locked Core service types. The S0 tests pass (shared + FakeProvider: 19, renderer lib: 11), and `biome check` is clean on the tracked sources. Two commands fail in this checkout, but neither is a contract defect. `npm run typecheck` fails because `ignore` is in `package.json` and the lockfile but is missing from `node_modules`; `npm ci` fixes that. `npm run lint` fails because Biome scans untracked agent worktrees (first finding below). The other findings are minor: the renderer clients and the test setup behave in ways that could mislead later sections.

## Findings

### [minor] `npm run lint` fails whenever agent worktrees exist inside the repo

ID: S0-N1

Status: open

- Location: `.gitignore:1`, `biome.json:3`
- Problem: Biome uses `useIgnoreFile: true`, and `.gitignore` does not cover `.claude/`. Each `.claude/worktrees/agent-*/` directory contains a full checkout with its own root `biome.json`, so `biome check .` stops with "Found a nested root configuration" before linting anything. This is happening right now at HEAD.
- Why it matters: plan rule 5 says every PR must pass `npm run lint`. The orchestration workflow that builds this repo creates these worktrees, so lint stays broken for as long as any of them exists.
- Direction: add `.claude/worktrees/` to `.gitignore`, or add `!.claude` to `files.includes` in `biome.json`.

### [minor] HttpApiClient's streams don't throw `ApiError` for failures after the response starts

ID: S0-N2

Status: open

- Location: `src/renderer/lib/http-api-client.ts:136`
- Problem: only the initial `fetch` is wrapped. If the connection drops mid-stream (dev server restart, proxy reset, `protocol.handle` body error), `reader.read()` throws a raw `TypeError`. A truncated or garbled frame makes `JSON.parse` throw a `SyntaxError`. Neither becomes an `ApiError`, which breaks the §4.9 promise that every method throws `ApiError` on network failure. No test covers a mid-stream error.
- Why it matters: S7 had to work around this. `stores/runs.ts:184` turns any non-`ApiError` into `network_error` but keeps the raw `err.message`, so users see engine text like "network error" or "Unexpected token…" instead of the standard copy. Any other consumer that trusts the contract with `instanceof ApiError` will miss these errors.
- Direction: in `stream()`, wrap the `readSSE` loop in try/catch. Rethrow aborts unchanged, map everything else to `ApiError(errorInfo('network_error', SERVER_UNREACHABLE))`, and add a test with a body that errors partway through.

### [minor] MockApiClient handles Stop differently from the real client

ID: S0-N3

Status: open

- Location: `src/renderer/lib/mock-api-client.ts:262-269`, `:277`
- Problem: on abort, the mock catches the rejection and yields `assistant_end` (status `stopped`) and then `done`, so the iterator finishes normally. `HttpApiClient` instead rejects with `AbortError`. The mock also waits out the tool pause without listening to the signal. A Stop pressed while a tool row is running only takes effect after the tool finishes. The next step then starts and is immediately stopped, leaving an empty `stopped` assistant message after the tool result.
- Why it matters: UI code or tests written against `VITE_API=mock` can expect a clean `done` after Stop and then break against the real server. The mock also shows a transcript (an empty stopped turn) that the real agent doesn't produce.
- Direction: pass `signal` to the tool pause, and on abort throw `signal.reason` after recording the partial message, so the mock rejects the way `HttpApiClient` does.

### [minor] The renderer Vitest project doesn't clean up Testing Library renders

ID: S0-N4

Status: open

- Location: `vitest.config.ts:17-22`
- Problem: the jsdom project has no `setupFiles` and no `globals: true`. Testing Library only cleans up between tests automatically when a global `afterEach` exists, so it doesn't here. Every renderer test file currently calls `cleanup` itself (I checked all 10). Any new file that forgets will leak DOM into the next test.
- Why it matters: leftover DOM between tests causes duplicate-match failures, or worse, assertions that pass by matching an element from a previous test.
- Direction: add a renderer `setupFiles` entry that registers `afterEach(cleanup)`, or set `globals: true` for that project.

### [minor] `.svg` is offered as a text attachment, but the mock rejects it

ID: S0-N5

Status: open

Duplicate of S7-N2 (same root cause; tracked there)

- Location: `src/shared/constants.ts:121` (`'svg'` in `TEXT_EXTENSIONS`), `src/renderer/lib/mock-api-client.ts:312`
- Problem: the file picker accepts `.svg` as text. The real server (S1 content sniffing) accepts it as UTF-8 text. The mock rejects any `image/*` type that isn't in `IMAGE_MIME_TYPES`, so an SVG gets `unsupported_file`. More generally, the mock decides by `file.type`, while the server decides by the file's leading bytes ("magic bytes").
- Why it matters: in mock mode, attaching an SVG shows an error card that never appears in dev or prod. That can mislead S7 attachment work.
- Direction: in the mock, decide image vs text from `IMAGE_MIME_TYPES` only and treat every other type as text, matching the server.

## Requirement gaps

None in the S0 files themselves. `typecheck` and `lint` don't pass in this checkout, for the environmental and worktree reasons above; both pass once those are fixed.

## Checked and sound

- `src/shared/types.ts`, `errors.ts`, `events.ts`, `api.ts`: match §4.1–4.4. ERROR_STATUS and ERROR_DEFAULTS cover all 18 codes, and a test checks this. `updateChatBody` tells "unchanged" apart from `projectId: null`. `sendMessageBody` requires text or an attachment and caps attachments at `LIMITS.attachmentsPerMessage`.
- `constants.ts`: `LIMITS` and `IMAGE_MIME_TYPES` match §4.5. `TEXT_EXTENSIONS` contains every extension in the plan's list. `DEFAULT_MODEL` is `anthropic/claude-sonnet-5.5`, as the plan notes record.
- `readSSE`: handles UTF-8 split across chunks, skips comment lines, and cancels the body on early `break` or `return`. All three are tested.
- Provider and Tool types, plus `ProviderError`, match §4.6 and §4.7. `core/types.ts` matches the locked service contract and the orchestrator notes. `CoreError` and `toErrorInfo` turn unknown errors into `internal` without leaking their messages.
- FakeProvider: the default script follows S0.7. The `README.md` tool call uses the `path` argument that S3's `read_file` expects. Abort works during both delays and events. Title requests (those with `maxTokens`) ignore the S9 markers, and only `title.ts` sets `maxTokens`.
- HttpApiClient: always sends `X-Harness-Client: 1`. JSON bodies get a content type, `FormData` bodies don't. Path params are URL-encoded. Aborts before the response pass through unchanged. Non-JSON error bodies fall back to a generic `ApiError`.
- No secrets leak: the API key appears only in the `PUT` body, and `PublicSettings` exposes only a hint. The mock's hint has the same `sk-or-v1-…xxxx` shape as S1's.
- Aliases come from one map in `renderer.vite.ts`, used by Vite, electron-vite (main, preload and renderer) and Vitest; tsx gets them from `tsconfig.base.json` paths. Strict mode and `noUncheckedIndexedAccess` are on. Vitest has two projects (node and jsdom). The `/api` proxy keeps the `localhost` Host header, which the §3.3 checks need.
- `tokens.css` contains every §5.1 token, the overlay colours and the self-hosted variable fonts. `global.css` applies the focus ring and the 0.15s transition rules.
- `package.json` pins exact versions for every dependency in §2 plus tsx, concurrently, Testing Library and jsdom. It matches the lockfile, including `ignore@7.0.14`.
