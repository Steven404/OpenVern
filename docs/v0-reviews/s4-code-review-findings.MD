# S4 code review findings

Reviewed branch `V0` at `ad1cf46`.
Model: Claude Opus 5.5, effort high.

## Summary

S4 mostly meets its acceptance bar. The event sequences for text-only, tool, abort mid-stream, abort mid-tool, provider error (including errors before any output), max steps and retry match §4.4 and the S4 notes, and `runTurn` turns every failure into events. I ran `npx vitest run src/core/agent`: 4 files and 61 tests pass. One correctness gap stands out. `buildHistory` always replays tool calls and tool results, even when the current request offers no tools. A chat that has used tools can therefore fail every later request once it switches to a non-tool model or loses its project. There are also two minor issues: a title overwrite race, and a project chat on a non-tool model gets no project tree in its system prompt.

## Findings

### [major] Tool calls and results are replayed to requests that offer no tools

ID: S4-M1

Status: fixed in 3f824a0

- Location: `src/core/agent/history.ts:419-433`; `src/core/agent/loop.ts:171`, `:187-191`, `:206`
- Problem: `buildHistory` always emits the assistant `toolCalls` and the matching `role:'tool'` messages. It never learns whether this request offers tools. `loop.ts` drops the `tools` field when `toolSpecs` is empty (S4.8) but still sends that history. Concrete triggers:
  - (a) A project chat uses `read_file` with a tool model. The user then picks a model with `supportsTools: false`, which the plan explicitly supports for project chats, and sends a follow-up.
  - (b) The project is deleted or the chat is detached (`chats.detachProject` / `PATCH projectId: null`), so it becomes a loose chat with no tools. The next message still carries `tool_calls` and tool messages.

  In both cases the request has tool content but no tool definitions. Anthropic rejects that combination. OpenRouter may also fail to route tool content to a non-tool endpoint, which the adapter maps to `model_no_tools` (`openrouter.ts:45,66`). How OpenRouter handles each case is not yet confirmed with a live request.
- Why it matters: If the provider rejects it, every later turn in that chat fails with that model. Retry does not help, because the tool messages come before the last user message. S4.7 says the history must stay valid, and this case breaks that.
- Direction: Pass "tools offered for this request" into `HistoryOptions`. When it is false, turn past tool calls and their results into plain assistant text (for example `[read_file README.md → <summary>]`) instead of emitting `toolCalls` and `tool` messages. Add a loop test where a tool turn is followed by a turn on a non-tool model or in a loose chat, and assert the second request has no `tool` messages.

### [minor] Auto-title can overwrite a rename the user made during the title request

ID: S4-N1

Status: fixed in 3f824a0

- Location: `src/core/agent/loop.ts:335-347`
- Problem: The epilogue checks `chat.title === NEW_CHAT_TITLE`, then waits up to 10 s on `generateTitle`, then calls `chats.update(chatId, { title })` without checking the title again. `PATCH /chats/:id` is not blocked while a run is active (`server/routes/chats.ts:47-50`). If the user renames the chat in that window, the generated title replaces their rename.
- Why it matters: S4.10 limits auto-titling to chats whose title is still `NEW_CHAT_TITLE`, and the user's rename is silently lost.
- Direction: Read the chat again just before saving, and only save if the title is still `NEW_CHAT_TITLE`. Ideally do the check and the write together inside the chats lock.

### [minor] Project chats on a non-tool model get no project tree

ID: S4-N2

Status: fixed in 3f824a0

- Location: `src/core/agent/loop.ts:173`; `src/core/agent/system-prompt.ts:558-567`
- Problem: S4.9 asks for `renderTree(depth 2, systemPromptTreeEntries)` in every project-chat system prompt. The code only calls `renderTree` when tools are offered. The no-tools project prompt also omits the tree, and the S4 notes do not cover this deviation.
- Why it matters: A model that can't use tools would get the most value from the tree, because it has no other way to see the project's structure. Today it is told only that it cannot read files.
- Direction: Render the tree whenever the chat has a project, and include it in both project prompts. Otherwise, record the omission in the S4 notes.

## Requirement gaps

- S4.9: the tree is missing from project-chat prompts when the model can't use tools (see the minor finding above). Every other S4.1–S4.11 item is met once the S4 notes are taken into account.

## Checked and sound

- **`runTurn` never throws.** The `emit` wrapper swallows emit failures, `execute` errors become one `error` event, the epilogue catches everything, and `done` is in `finally`. The run is removed from the registry before `done`.
- **Run registration.** The run is registered synchronously, before the first `await`. A second run on the same chat gets `conflict` + `done`. `abort(chatId)` and the caller's signal both feed the same per-run controller.
- **Event order.**
  - Text and tool turns follow §4.4, with `tool_call` before `tool_result` for each call and calls run in order.
  - Error turns end `assistant_end → error → chat_updated → done`, and stopped turns end `assistant_end → chat_updated → done`, as the notes describe.
  - Max steps runs exactly `MAX_AGENT_STEPS` model calls, then emits `error` `max_steps_reached`.
- **Abort mid-stream.** The partial text is saved with `status: 'stopped'`. Tool calls that finished streaming are dropped, there is no `error` event and no title.
- **Abort mid-tool.** The running call and all pending calls get persisted `ok: false` "Interrupted" tool messages. A tool result that arrives after the abort is replaced, so the stored outcome does not depend on timing.
- **Provider errors.** An error at stream start or mid-stream saves `status: 'error'` with the error, and an empty message is saved when there was no output. Earlier tool results in the turn are kept.
- **Tool argument handling.** Unknown tools, invalid JSON and empty arguments (treated as `{}`) are handled, and a tool that throws becomes a generic `ok: false` result.
- **S4.8.** Tools are offered only when the project exists and `supportsTools` is true. A project that has since been deleted makes the chat a loose chat.
- **History.**
  - Text attachments are wrapped in `<attached_file>` before the user's text, with the name escaped.
  - Images become parts only for vision models; other models get the exact omission text. A missing attachment gets a placeholder.
  - Empty stopped or error messages are skipped. Calls with no result get the synthetic Interrupted result, and orphan tool results are dropped.
  - `providerMeta` is replayed only to the model that produced it.
- **Retry.** It truncates after the last user message, emits no `user_message`, and fails cleanly when there is nothing to retry.
- **Title generation.**
  - It uses the same model, with no tools, `maxTokens: 30`, and a 10 s timeout through `AbortSignal.any`.
  - The input is capped at 1,000 characters. The fallback is the first 60 characters, or the first attachment's name when there is no text.
  - It only runs after a completed turn while the title is `NEW_CHAT_TITLE`, and `done` waits for it.
  - `chat_updated` is sent for model and `updatedAt` changes.
- **Tests.** Every scenario listed in S4.11 has a matching test, and all of them pass.
