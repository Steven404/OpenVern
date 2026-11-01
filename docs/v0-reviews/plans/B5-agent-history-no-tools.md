# B5 — Agent history without tools (S4-M1, S4-N1, S4-N2)

Files: `src/core/agent/history.ts`, `loop.ts`, `system-prompt.ts` and their tests. No other source changes. Keep `deps.renderTree` as is (the B2 `deniedRoots` is closed over in `src/core/index.ts:30`).

## Settled design (S4-M1)
- `HistoryOptions` gets a **required** field `toolsOffered: boolean` ("this request includes tool definitions"). Required so `tsc` flags every caller. The only caller is `loop.ts:187`. Pass `toolsOffered: toolSpecs.length > 0`.
- `toolsOffered: true`: same output as today.
- `toolsOffered: false`: emit no `toolCalls` (always `[]`) and no `role:'tool'` messages. An assistant message that has tool calls becomes one assistant message. Its `text` is `[m.text, ...m.toolCalls.map(c => flattenToolCall(c, results.get(c.id)))]` with empty strings removed, joined with `'\n\n'`. Nothing is trimmed.
- New exports in `history.ts`:
  - `FLATTENED_TOOL_OUTPUT_CHARS = 2000`. This is local, not in `LIMITS`. `LIMITS.readFileMaxBytes` is 100 KB, which is far too large to replay to a model that can't act on it.
  - `FLATTENED_TOOL_ARGS_CHARS = 300`.
  - `flattenToolCall(call: ToolCall, result: ToolMessage | undefined): string`.
- Exact format of `flattenToolCall`:
  - Header `[tool ${call.name} ${args} → ${ok ? 'ok' : 'error'}]`, where `args = call.argsJson.trim() || '{}'`. If `args` is longer than 300 chars, cut it to 300 and append `…`.
  - If the output is not empty, add `'\n' + output`. An output longer than 2000 chars becomes `output.slice(0, 2000) + '\n[… ${output.length - 2000} more characters truncated]'`.
  - A missing result counts as `ok: false` with output `INTERRUPTED_OUTPUT`. So a stopped call renders as `[tool read_file {"path":"x"} → error]\nInterrupted: the run was stopped before this tool finished.`
- `providerMeta`: drop it on every assistant message that had tool calls and was flattened. The OpenRouter adapter replays it as `reasoning_details`, and that data belongs to the original tool-call content. Assistant messages without tool calls keep today's rule (same model only).
- Alternation: only when `toolsOffered: false`, if the previous `out` entry is an assistant message, append this assistant's text to it with `'\n\n'` and delete its `providerMeta`. Don't push a second one. The stored sequence `user, assistant(tc), tool, assistant` then becomes `user, assistant, …`. No message is empty, because the filter means a flattened message always has at least one tool header.
- Update the JSDoc rules block (`history.ts:39-48`) with one bullet for this.

## Tests first (all fail today)
1. `history.test.ts`. Add `toolsOffered: true` to the `opts()` helper (l.34). Without it, typecheck fails once the field is required. Add:
   - `'flattens tool calls and results into assistant text when no tools are offered'`. Input: `user('q'), assistant({text:'x', toolCalls:[c1 {"path":"a"}, c2 '']}), tool('c1','out'), assistant({text:'done'}), user('q2')`, with `opts({toolsOffered:false})`. Assert with `toEqual`: `[user q, {role:'assistant', text:'x\n\n[tool read_file {"path":"a"} → ok]\nout\n\n[tool read_file {} → error]\n' + INTERRUPTED_OUTPUT + '\n\ndone', toolCalls:[]}, user q2]`. It fails today: tool messages and `toolCalls` are emitted.
   - `'truncates long tool output and marks failed results when flattening'`. Use a tool with `ok:false`, and an output of `'a'.repeat(2050)`. Assert `→ error` and the exact `[… 50 more characters truncated]` suffix.
   - `'drops providerMeta from flattened messages; empty text gives just the tool block'`. Use `assistant({text:'', model:'m', providerMeta:{r:1}, toolCalls:[c1]})`. Assert there is no `providerMeta` and the text starts with `[tool`.
2. `loop.test.ts`, new `describe('history when tools are no longer offered')`. Both tests use `scriptFromTurns([callTools([['c1','read_file','{"path":"README.md"}']], 'Reading. '), reply('It is a readme.'), TITLE_TURN, reply('Still here.')])`. Both call `await h.run()` and then a second `h.run({ newUserMessage: { text: 'And now?', attachmentIds: [] }, … })`. The request under test is `h.provider.calls[3]`.
   - (a) `'a tool turn followed by a turn on a non-tool model sends flattened text'`. Use `models: [model(MODEL), model('plain/model', { tools: false })]`, and run the second turn with `model: 'plain/model'`.
   - (b) `'a tool turn followed by a turn after the project is detached sends flattened text'`. Call `await h.chats.detachProject(PROJECT.id)` between the two runs.
   - Assert in both: `req.tools` is undefined. No message has `role === 'tool'`. Every assistant message has `toolCalls` equal to `[]`. `req.messages` equals `[user 'Hello there', {role:'assistant', text:'Reading. \n\n[tool read_file {"path":"README.md"} → ok]\ncontents of README.md\n\nIt is a readme.', toolCalls:[]}, user 'And now?']`. Today this fails because `tool` messages and `toolCalls` are sent.
3. S4-N1, `loop.test.ts` text-only describe: `'a rename made while the title is generated wins'`. Write `let h!: Harness`, then `h = await createHarness({ script: (_req, i) => { if (i === 1) void h.chats.update(h.chatId, { title: 'User rename' }); return i === 0 ? reply('Hi') : TITLE_TURN; } })`. The fake `update` mutates synchronously, so the rename lands while the title request is in flight. Assert that the stored title is `'User rename'` and that `chat_updated` was emitted once. Import the `Harness` type from `./test-helpers`, which already exports it. Today it fails: the title becomes `'Friendly greeting'`.
4. S4-N2:
   - `system-prompt.test.ts:35`: rename the test to `'project chat without tool support: says it cannot read files but shows the tree'`. Assert that `p` contains `"can't use tools"` and `'src/'`, and does not contain `'list_files'`.
   - `loop.test.ts:261` (`'offers no tools when the model does not support them'`): change `toHaveLength(0)` to `toEqual([{ root: PROJECT.rootPath, opts: { depth: 2, maxEntries: 100 } }])`, and add `expect(system).toContain('README.md')`.
   - Both fail today: no tree is rendered.

## Fix steps
1. `history.ts`: add the field, the constants and `flattenToolCall`. In `buildHistory` (l.60-75), branch on `opts.toolsOffered` as designed. Import `ToolCall` from `@shared/types`.
2. `loop.ts:187-191`: add `toolsOffered: toolSpecs.length > 0`. `toolSpecs` is already defined at l.186, above the call.
3. `loop.ts:173` (S4-N2): change `if (project && tools.length > 0)` to `if (project)`. Leave the `try`/`catch` unchanged.
4. `system-prompt.ts`:
   - Extract the tree block (l.69-77) into `function treeLines(tree?: string): string[]`, which returns `[]` when the tree is blank. Use it in both project branches.
   - In the no-tools branch (l.41-49), use these lines:
     `"This chat is attached to the project above, but the selected model can't use tools, so you cannot open or search its files. You can only see the top of its folder structure (below)."`
     `"Don't guess about file contents. If you need to see code, ask the user to paste it or to pick a model that supports tools."`
   - Then the Markdown line, then `...treeLines(tree)`.
   - Change the `tree` doc comment (l.11) to "used in every project prompt".
5. `loop.ts:346-347` (S4-N1): before `chats.update`, add `const latest = await chats.get(input.chatId); if (latest.title !== NEW_CHAT_TITLE) return;`. `ChatsService` does not change.

## Interfaces changed
`HistoryOptions.toolsOffered` (required). The new exports `flattenToolCall`, `FLATTENED_TOOL_OUTPUT_CHARS` and `FLATTENED_TOOL_ARGS_CHARS` are not re-exported from `agent/index.ts`. `SystemPromptInput.tree` is now used for all project chats.

## Risks
- The model may copy the `[tool …]` text format in its own replies. This is acceptable, because it only happens on models that can't call tools.
- Up to 2000 chars per result of earlier tool output now goes to a model or provider that may be different from the original one. This is the same data the user already put into the chat.
- N1 still has a small race window between `get` and `update`. Closing it needs a conditional update inside the lock, which would change the interface. That is deferred.
- Don't mutate `out` entries shared with anything else when merging. `out` is local, so this is safe.

## Blocked / follow-up (product decisions)
- In-run hallucinated tool calls (`loop.ts:250-261`, test `'a hallucinated tool call in a toolless chat…'`) still push `toolCalls` and `tool` messages into the next step's request, even though no tools are offered. Flattening them there would leave the request ending on an assistant message. The other option is to ignore tool calls when no tools are offered, which changes that test's contract. Not in B5; needs a decision.
- How OpenRouter handles these requests is still not checked with a live request (see the finding).

## Verification
`npx vitest run` (all green, including the edited tests), `npm run typecheck`, `npm run lint`.
