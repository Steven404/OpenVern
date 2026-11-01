# S7 code review findings

Reviewed branch `V0` at `ad1cf46`.
Model: Claude Opus 5.5, effort high.

## Summary

S7 meets its acceptance bar for behaviour on the main paths. The runs store applies events in order and is guarded by a token per run. Leaving a chat does not abort the run; Stop aborts the fetch, then the store polls until the stopped message is saved; `done` refetches the chat; `chat_updated` patches the cached summaries; and Retry resends the typed message when the server never saved it. The conversation, the composer and the new-chat screen follow the S7 rules, and the S7 tests pass (5 files, 59 tests). I found three minor defects: Stop during a tool run loses the "Stopped" label and Retry, `.svg` files are wrongly treated as images, and tool calls that are only queued show as running.

## Findings

### [minor] Stop during a tool run leaves no "Stopped" label and no Retry

ID: S7-N1

Status: fixed in 14c4f0c

- Location: `src/renderer/stores/runs.ts:237-241` (with `src/renderer/features/conversation/Conversation.tsx:112`)
- Problem: The trigger is a model reply that asks for a tool. The user presses Stop while `read_file` is running. The server saves the assistant message as `complete` (its tool calls are listed) and the tool result as "Interrupted". It saves no message with `status: 'stopped'`. In the client, `aborted` sets `run.stopped = true`, but `streamingId` is null, so no message is marked stopped. `settle` then finds the overlay covered on the first poll and, with no error, deletes the run entry. `run.stopped` goes with it. The last turn ends on a ✕ tool row. The "Stopped" label only shows during the settle window, and no Retry is offered: `onRetry` attaches only to the last text block or to a run error.
- Why it matters: S7.2 and S7.8 require a stopped run to show "Stopped" and offer Retry. Stopping during a tool run is a common case for the agent.
- Direction: When the run ended by abort (`run.stopped`), keep a small entry after settle (for example `{status:'idle', messages:[], stopped:true}`), as the store already does for `error`. Clear it on the next send or retry. Conversation already renders `turnStopped` with Retry for the last turn.

### [minor] `.svg` files are classified as images: refused, or dropped with the vision message

ID: S7-N2

Status: fixed in c2659ad

- Location: `src/renderer/features/composer/attachments.ts:356` (used at lines 405-416)
- Problem: `isImageFile` checks `file.type.startsWith('image/')`, and Chromium reports `.svg` as `image/svg+xml`. `.svg` is in `TEXT_EXTENSIONS`, so it is in `TEXT_ACCEPT` and the picker offers it for every model.
  - With a vision model, the chip fails client-side with the unsupported-file error and is never uploaded.
  - With a model without image input, the file is silently dropped and the red "This model does not support image input" appears.

  The server would accept the file and store it as text. This is a separate check in the composer, not the already-filed mock behaviour, and it also happens with `HttpApiClient`.
- Why it matters: A listed text type can never be attached, and the error message given is misleading.
- Direction: Treat a file as an image only if its MIME type is in `IMAGE_MIME_TYPES`. Let every other file through as text, so the server's sniffing decides, which matches the server.

### [minor] Queued tool calls show a spinner before their `tool_call` event

ID: S7-N3

Status: fixed in 14c4f0c

- Location: `src/renderer/features/conversation/turns.ts:234`
- Problem: A tool row's state is `result ? … : active ? 'running' : 'skipped'`. `run.runningToolIds`, which the store fills from `tool_call` events, is never used. The trigger is a step that requests three `read_file` calls. After `assistant_end`, all three rows spin at once, although the server runs them one at a time and §4.4 says it is the `tool_call` event that marks a call as running.
- Why it matters: The tool row states (S7.6) misreport progress during multi-call steps. The data to fix it is already in the store.
- Direction: Pass `runningToolIds` into `buildTurns`. Show `running` only for those ids. Show calls that are still pending in an active run as queued or neutral rather than with a spinner.

## Requirement gaps

- S7.2 / S7.8: no "Stopped" label and no Retry after a stop during a tool run (first finding). All other S7.1–S7.17 items are met, given the S7 notes.

## Checked and sound

- `reduceRun`:
  - Events are applied in order and are idempotent for repeated ids.
  - The pending user message is swapped in on `user_message`.
  - `error` and `aborted` mark only the streaming message.
  - A stream that ends without `done` becomes a `network_error`.
  - The `token` guard stops a late settle from clobbering a newer run.
- Navigating away does not abort. Controllers are per chat, and `stop` aborts only that chat's fetch.
- The post-abort poll (≤ 5 tries, about 1.85 s) exits as soon as the server has saved the messages.
- Retry:
  - When the user message was never saved, it resends via `sendMessage`.
  - Otherwise the cache is cut to the last user message, which matches what the server does.
- `patchChatSummary` patches both the chats list and the chat entry, and re-sorts the list.
- `mergeMessages` cuts at the first overlay id, so a refetch during a run does not duplicate messages. Turn grouping gives one article per turn, in order.
- Error cards:
  - Key and credit errors offer "Open settings", and only those.
  - Retry is offered only when the error is retryable or the message was never sent, and only on the last turn when no run is active.
  - A saved error is not shown twice, because `lastAssistantErrored` suppresses the run-level card.
- Markdown:
  - No `rehype-raw`, so raw HTML is escaped.
  - react-markdown's default `urlTransform` strips `javascript:` links.
  - Links get `target="_blank"` with `rel="noopener noreferrer"`.
  - The CSP `img-src 'self' data: blob:` blocks remote images in Electron.
- Streaming:
  - `useFrameThrottled` limits rendering to one update per frame, and its StrictMode fix holds.
  - `findOpenFence` keeps the open block plain. Finished blocks are highlighted once, because `CodeBlock` is memoised.
  - Shiki loads languages lazily and uses the JS regex engine.
- Composer:
  - Enter sends; Shift+Enter, `isComposing` or keyCode 229 do not.
  - Send is disabled with no content, while uploading, with no key, or while a run is running or settling.
  - Stop replaces Send while streaming.
  - `accept` follows the model's `supportsImages`.
  - Switching to a model without vision removes the images, deletes them on the server and shows the exact red sentence. The sentence clears on send, on the next file added and on the next model change, and there is a last guard at send time.
  - Uploads removed mid-flight are deleted when they finish.
- Model picker:
  - The `Provider: ` prefix is stripped.
  - Search matches on name and id.
  - Context size and the Tools / Vision badges are shown.
  - Choosing a model PATCHes `lastModel`.
  - With no key, the trigger reads "Add API key" and opens Settings.
- New chat:
  - The project is preselected from `?project=`. `useNewChatPath` supplies the current chat's project.
  - `resolveDefaultModel` follows lastModel → DEFAULT_MODEL → the first model with tools and vision.
  - On first send it runs `createChat`, puts the chat in the cache and the chats list, navigates, then calls `send`. The run starts synchronously before the first await, so the conversation sees it when it mounts.
  - If `createChat` fails, the text and attachments are restored.
