# S2 code review findings

Reviewed branch `V0` at `ad1cf46`.
Model: Claude Opus 5.5, effort max.

## Summary

S2 meets its acceptance bar. The two test files (63 tests, all passing at `ad1cf46`) cover every S2.1–S2.10 bullet with hand-built fixtures and no network, except that nothing proves parsing stops at `[DONE]`. Key handling is sound: the key only goes into the `Authorization` header, never into a URL, a log, the cache file or a `ProviderError` message. Stream parsing, the error table and the catalog match the spec; the four findings are minor and none affects billing or tool-call correctness. The only open item is the live check of `reasoning_details` merging, which the S2 notes already defer to S9.

## Findings

### [minor] A malformed pasted key is reported as "Couldn't reach OpenRouter"

ID: S2-N1

Status: open

- Location: `src/core/providers/openrouter.ts:360` (reached from `validateKey`, `:388`)
- Problem: `request()` turns every `fetch` rejection that isn't an abort into `network_error`. That includes the `TypeError` that `fetch` throws locally, before connecting, when the `Authorization` value is invalid. `setOpenRouterKeyBody` (`z.string().trim()`, `src/shared/api.ts:36`) only trims the ends of the key. So a key pasted with a line break in the middle (copied across a wrap) or with a zero-width space reaches `validateKey`, which returns "Couldn't reach OpenRouter. Check your connection." I reproduced both cases offline with the real `fetch`, pointed at a blocked loopback port.
- Why it matters: First-run key setup tells the user to fix their network, and the key can't be saved. Nothing leaks today, but only because the raw error is thrown away. In the newline case its message is `Headers.append: "Bearer sk-or-v1-…" is an invalid header value.`, which contains the full key.
- Direction: In `validateKey`, reject keys that aren't one printable-ASCII token (e.g. `/^[\x21-\x7e]+$/`) with `invalid_api_key` before calling fetch. The alternative is to map only rejections that carry a `cause` (undici's real network failures) to `network_error`. Either way, never log or show the raw fetch error.

### [minor] Non-JSON error bodies (HTML pages) become user-facing error text

ID: S2-N2

Status: open

- Location: `src/core/providers/openrouter.ts:99` (the message is built at `:54`)
- Problem: When an error body isn't JSON, its first 300 characters become the error detail. `provider_error` appends it to "The model provider returned an error: …", and `invalid_request` uses it as the whole message. A Cloudflare-style 524 page, fed in through an injected fetch, produced `The model provider returned an error: <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> …`.
- Why it matters: §4.2 says `message` is user-facing copy. During OpenRouter or Cloudflare outages, HTML markup shows up in the chat error card and in the Settings modal's key check (any 5xx from `validateKey`). The "500 with a non-JSON body" test (`openrouter.test.ts:392`) checks code, retryable and status but not the message, so it can't catch this.
- Direction: Use non-JSON text only to classify the error, and keep the default message, optionally with the status ("OpenRouter returned HTTP 524"). Add an HTML-body test case that checks the message.

### [minor] No test proves parsing stops at `[DONE]`

ID: S2-N3

Status: open

- Location: `src/core/providers/openrouter.test.ts:177`
- Problem: Every fixture and inline stream ends exactly at `data: [DONE]`. The tests show `[DONE]` isn't parsed as JSON, but not that reading stops there. Replacing the `break` at `openrouter.ts:232` with `continue` would still pass all 63 tests, even though the test is named "[DONE] ends it".
- Why it matters: "Stop at `[DONE]`" is the one S2.3 behavior the fixtures don't exercise, so S2.11's "fixtures cover every bullet" isn't literally true. The `break` is also what cancels the upstream body, through `readSSE`'s `finally`.
- Direction: In one test, add a frame after `[DONE]` (e.g. `data: {not json` or an extra content delta) and assert that it's ignored.

### [minor] Attribution headers hard-code `'harness'` instead of using `APP_NAME`

ID: S2-N4

Status: open

- Location: `src/core/providers/openrouter.ts:350`
- Problem: `X-OpenRouter-Title` and `X-Title` are string literals (`:350–351`). §2 keeps the app name in the single `APP_NAME` constant, which the system prompt, window title, document title and sidebar already use.
- Why it matters: Renaming the app through `APP_NAME` would leave the old name in OpenRouter's app attribution and activity page, which defeats §2's "rename later is cheap".
- Direction: Import `APP_NAME` from `@shared/constants` for both headers, and make the test compare against it.

## Requirement gaps

- **S2 acceptance command:** `npx tsx scripts/try-openrouter.ts "hello"`, exactly as written in the plan, fails with `ERR_MODULE_NOT_FOUND: Cannot find package '@shared/errors'`. The root `tsconfig.json` only lists references and has no `paths`. The `--tsconfig tsconfig.node.json` form from the S2 notes resolves the imports and reaches the key check; I ran it without a key, so no request was sent. The S2 notes already document this. Fixing it means changing a root config or the plan text, not the S2 files.

ID: S2-G1

Status: open

## Checked and sound

- **API key:**
  - It is sent only as `Authorization: Bearer` on `/chat/completions`, `/models` and `/key`.
  - It never appears in URLs, logs, `cache/models.json` or `ProviderError` messages.
  - `validateKey` uses the key being checked, not the stored one; the test stores `null` to prove this.
  - `no_api_key` is thrown before any fetch.
  - A CR or LF in the key can't inject headers, because `fetch` rejects the value (verified).
- **`try-openrouter.ts`:** the key comes only from the environment and is never printed. Errors print only code, status, retryable and message. Ctrl+C (SIGINT) aborts through the signal.
- **Request mapping (S2.2/S2.7):**
  - The system message comes first.
  - Images are sent as `data:` URLs.
  - An assistant turn with only tool calls gets `content: null`, and tool results carry `tool_call_id`.
  - `reasoning_details` is sent back only when it's a non-empty array, which matches the full-array round trip in the [OpenRouter reasoning-tokens guide](https://www.openrouter.ai/docs/guides/best-practices/reasoning-tokens).
  - Reasoning is never requested.
- **Stream parsing (S2.3/S2.4):**
  - Tool deltas are collected by `index`: the first id and name win, arguments are concatenated, calls are emitted in index order, and empty arguments become `{}`.
  - Tool calls and `meta` are emitted at the first `finish_reason`. The usage chunk's repeated `finish_reason` is ignored, so there is exactly one `usage` and one `finish`.
  - A stream that ends with neither `finish_reason` nor `[DONE]` becomes `network_error`.
  - A mid-stream `error` chunk (string or numeric code) and a bare `finish_reason: "error"` both throw.
  - Index reuse: Ollama is known to send `index: 0` for every call ([vercel/ai#14277](https://github.com/vercel/ai/pull/14277)), but I found no OpenRouter report of it, so I didn't file it.
- **Abort (S2.6):** the signal is passed to every fetch. Aborts are rethrown as-is, not relabeled `network_error`, by both `request()` and `parseStream`.
- **Error mapping (S2.5/S2.8):**
  - Codes and retryable flags match the plan's table.
  - 403 maps to a non-retryable `provider_error`.
  - `/key` returning 401 or 403 maps to `invalid_api_key`.
  - The upstream `metadata.raw` text is used only to classify errors and is never shown.
- **`listModels` (S2.9):**
  - Only models with text output are kept.
  - Prices are multiplied by 1e6 without float noise, and negative router prices become `null`.
  - Context length falls back to `top_provider.context_length`.
  - `supportsTools` and `supportsImages` are derived correctly.
- **Catalog (S2.10, including ad1cf46):**
  - The 1 h TTL boundary, disk-cache validation and serving stale data on failure all work.
  - An abort is not hidden behind stale data.
  - The 60 s backoff works and `refresh` bypasses it.
  - `resetFailure` is called on both key save and key removal.
  - The cache is written to a temp file, fsynced, then renamed.
  - `get()` never throws and returns the unknown-model default (`supportsTools: true`, `supportsImages: false`).
