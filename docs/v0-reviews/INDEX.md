# V0 review findings: index and triage

Source: `s0`–`s9-code-review-findings.MD` (reviewed at `ad1cf46`). Triaged 2026-11-02.

**ID scheme:** `S<goal>-M<n>` = major, `S<goal>-N<n>` = minor, `S<goal>-G<n>` = requirement gap with no matching finding. Numbers follow the order in the source file. Each finding in its source file has `ID:` and `Status:` lines under its heading.

**Totals:** 35 entries (5 major, 29 minor, 1 gap). One duplicate is merged (S0-N5 → S7-N2), leaving 34 work items.
Labels: 27 mechanical, 5 needs-design, 2 needs-user (plus the merged duplicate). 10 are security-sensitive.

**Precondition for Phases 2–4:** `node_modules` in this checkout is stale (`ignore@7.0.14` is in the lockfile but not installed). Several reviewers could not run the full suite because of it. Run `npm ci` before the first batch.

**Out of scope (not code findings):** S9.2 (manual §8 runs on CachyOS/Arch, including the AppImage) and S9.5 (tag `v0.1.0`).

---

## Findings

### S0: contracts, clients, tooling

| ID | Title | Sev | Files / functions | Dependencies | Label | Sec |
|---|---|---|---|---|---|---|
| S0-N1 | `npm run lint` fails whenever agent worktrees exist | minor | `.gitignore`, `biome.json` (`files`) | None. `.claude/` currently contains only `worktrees/`, so ignoring `.claude/worktrees/` is safe. | mechanical | no |
| S0-N2 | HttpApiClient streams don't throw `ApiError` after the response starts | minor | `src/renderer/lib/http-api-client.ts` `HttpApiClient.stream()` (readSSE loop, `JSON.parse`); new test | Brings the client in line with the §4.9 contract. Makes the workaround in `stores/runs.ts` `toErrorInfo` redundant; leave that alone (B6 owns runs.ts). Related to S6-N3 (network_error copy). | mechanical | no |
| S0-N3 | MockApiClient handles Stop differently from the real client | minor | `src/renderer/lib/mock-api-client.ts` stream/send path (`pause`, abort catch, l.262–277) | Changes what the mock yields on Stop. `runs.test.ts`, `Conversation.test.tsx`, `Composer.test.tsx`, `NewChatScreen.test.tsx` and `Sidebar.test.tsx` all run on the mock, so some may expect a clean `done`. Goes with S7-N1 (B6). | needs-design | no |
| S0-N4 | Renderer Vitest project doesn't clean up Testing Library renders | minor | `vitest.config.ts` (renderer project), new renderer setup file | None. Don't remove the existing per-file `cleanup` calls (that would touch 10 test files that other batches own). | mechanical | no |
| S0-N5 | `.svg` offered as text, but the mock rejects it | minor | `src/renderer/lib/mock-api-client.ts` `uploadAttachment` (l.312) | **Duplicate of S7-N2** | (merged) | no |

### S1: storage

| ID | Title | Sev | Files / functions | Dependencies | Label | Sec |
|---|---|---|---|---|---|---|
| S1-M1 | A project folder can contain the data dir, so `read_file` returns the plaintext key | **major** | `src/core/storage/projects.ts` `createProjectsService` / `create`; `src/core/storage/index.ts` `createStorage` (l.55). Option B also: `src/core/tools/sandbox.ts` `resolveInProject`, `walk.ts` `walk`, `tools/index.ts` `getProjectTools`, core wiring | **Option A** (reject at create) adds an optional field to `ProjectsServiceOptions`. Its only caller is `storage/index.ts:55`. It doesn't protect projects that are already saved. **Option B** (deny in the sandbox) changes the signature of `resolveInProject(root, relPath)` and `WalkOptions`, which `list_files`, `read_file`, `search` and `renderTree` all use. B overlaps S3-M1 in `walk.ts`, so S3-M1 goes first. Same function as S1-N1. | **needs-user** (Q1) | **yes** |
| S1-N1 | Relative project paths resolve against the server's cwd | minor | `src/core/storage/projects.ts` path normalisation (l.27) in `create`; `projects.test.ts` | Same code as S1-M1, so same batch. The mock already rejects these, so no renderer change is needed. | mechanical | **yes** |
| S1-N2 | Chat id `index` maps onto `chats/index.json` | minor | `src/core/storage/chats.ts` `chatFile` (l.40) / `SAFE_ID`; `chats.test.ts` | None. Refuse `index` rather than require a UUID: tests use ids like `chat-1`. | mechanical | no |
| S1-N3 | Orphan cleanup deletes the bytes behind a quarantined sidecar | minor | `src/core/storage/attachments.ts` `cleanupOrphans` (stray `.bin` pass, l.217); `attachments.test.ts` | None | mechanical | no |

### S2: OpenRouter provider

| ID | Title | Sev | Files / functions | Dependencies | Label | Sec |
|---|---|---|---|---|---|---|
| S2-N1 | Malformed pasted key reported as "Couldn't reach OpenRouter" | minor | `src/core/providers/openrouter.ts` `createOpenRouterProvider` → `validateKey`, `request()`; `openrouter.test.ts` | Related to S6-N3: once this is fixed, the server's `info.message` is right, and S6-N3 can simply show it. | mechanical | **yes** (the raw fetch error contains the full key) |
| S2-N2 | Non-JSON (HTML) error bodies become user-facing text | minor | `openrouter.ts` `errorFromResponse` (l.87–99), `providerError` (l.50); test | Same file as S2-N1/N3/N4 | mechanical | no |
| S2-N3 | No test proves parsing stops at `[DONE]` | minor | `openrouter.test.ts` (l.177) | Test only | mechanical | no |
| S2-N4 | Attribution headers hard-code `'harness'` instead of `APP_NAME` | minor | `openrouter.ts` `createOpenRouterProvider` headers (l.350); test | None | mechanical | no |
| S2-G1 | Plan's acceptance command `npx tsx scripts/try-openrouter.ts` fails (root tsconfig has no `paths`) | gap | root `tsconfig.json` **or** the plan text / `package.json` script | Changing the root tsconfig could affect every tool that reads it (tsx, IDE, Vitest aliases) | **needs-user** (Q2) | no |

### S3: tools

| ID | Title | Sev | Files / functions | Dependencies | Label | Sec |
|---|---|---|---|---|---|---|
| S3-M1 | Walker reads `.gitignore` through symlinks, FIFOs and devices, even outside the root | **major** | `src/core/tools/walk.ts` `readGitignore` (l.28), `walk` ancestor loop (l.56) and per-dir check (l.75); tools tests (new symlink/FIFO fixture) | No signature change. `walk` is used by `list_files`, `search` and `renderTree` (and so by the S4 system prompt). Do it before S1-M1 option B, which also edits `walk.ts`. | mechanical | **yes** (file access outside root) |
| S3-N1 | Single-line cut ignores `readFileMaxBytes` for multibyte text | minor | `src/core/tools/read-file.ts` `createReadFileTool` (l.103); `tools.test.ts` (l.230) | None. `tools.test.ts` is also edited by B1 (S3-M1), but B1 runs in Phase 2, before this. | mechanical | no |

### S4: agent loop

| ID | Title | Sev | Files / functions | Dependencies | Label | Sec |
|---|---|---|---|---|---|---|
| S4-M1 | Tool calls/results replayed to requests that offer no tools | **major** | `src/core/agent/history.ts` `HistoryOptions`, `buildHistory` (l.419–433); `src/core/agent/loop.ts` (l.171, 187–191, 206); `history.test.ts` (`opts()` helper), loop tests | Adds a field to `HistoryOptions`. The only caller is `loop.ts:187`; exported from `agent/index.ts`. The text format for flattened tool calls is a design choice. S4-N2 edits the lines right next to it. | needs-design | no |
| S4-N1 | Auto-title can overwrite a rename made during the title request | minor | `loop.ts` title epilogue (l.335–347) | The direction's "ideally inside the chats lock" would add a conditional-update method to `ChatsService` (interface change). Default: re-read just before saving, no interface change. | mechanical | no |
| S4-N2 | Project chats on a non-tool model get no project tree | minor | `loop.ts` (l.171–185, the `tools.length > 0` gate on `renderTree`); `src/core/agent/system-prompt.ts` `buildSystemPrompt` (no-tools project branch) | Same block as S4-M1. Default: follow the S4.9 spec and render the tree, instead of documenting the deviation. | mechanical | no |

### S5: server

| ID | Title | Sev | Files / functions | Dependencies | Label | Sec |
|---|---|---|---|---|---|---|
| S5-M1 | Disconnect before the stream opens is missed; chat stuck on 409 | **major** | `src/server/sse.ts` `streamTurn` (l.31–39); callers `routes/chats.ts:84,99` unchanged; new server test (slow `models.get` stub + image, then assert `isRunning` false and next send 200) | None. Direction is concrete. | mechanical | no |
| S5-N1 | Dev server accepts `Host: harness` over HTTP (DNS rebinding) | minor | `src/server/middleware/security.ts` `HOST_RE`, `isAllowedHost`, `security` middleware; `security.test.ts:42` | `isAllowedHost` is exported; check that callers outside the middleware (if any) still get the URL protocol. The Electron `app://` path must keep working. | mechanical | **yes** (auth / host check) |

### S6: settings and shell UI

| ID | Title | Sev | Files / functions | Dependencies | Label | Sec |
|---|---|---|---|---|---|---|
| S6-M1 | Save-key mutation keeps the full key in TanStack's mutation cache for 5 min | **major** | `src/renderer/features/settings/SettingsModal.tsx` `KeyForm` → `useMutation` (l.149), `save.mutate` (l.164); `SettingsModal.test.tsx` | None. Same file as S6-N2 and S6-N3. | mechanical | **yes** |
| S6-N1 | App-level modals return focus to an element that no longer exists | minor | `src/renderer/stores/ui.ts` `rememberFocus` (l.50); `src/renderer/components/ui/Dialog.tsx` `DialogContent` `onCloseAutoFocus` (l.38–43) | `Dialog.tsx` is a shared primitive. Change only the fallback behaviour, not its props. | mechanical | no |
| S6-N2 | Show/hide key toggle announces the opposite state | minor | `SettingsModal.tsx` toggle (l.199–200); test lookups | Same file as S6-M1. Default: fixed label "Show key" + `aria-pressed={visible}`. | mechanical | **yes** (whether the key is shown) |
| S6-N3 | Key error copy blames OpenRouter for local failures | minor | `SettingsModal.tsx` `keyErrorMessage` (l.14–17, used at l.125, l.181; exported from `features/settings/index.ts`, with no other consumers); Remove confirm | Related to S2-N1 and S0-N2. Default for a failed Remove: show the error inside the confirm. | mechanical | no |

### S7: conversation and composer

| ID | Title | Sev | Files / functions | Dependencies | Label | Sec |
|---|---|---|---|---|---|---|
| S7-N1 | Stop during a tool run leaves no "Stopped" label and no Retry | minor | `src/renderer/stores/runs.ts` `settle` (l.237–241); `features/conversation/Conversation.tsx` (l.112); `runs.test.ts` | Changes the runs-store contract: an `idle` + `stopped` entry stays after settle. Composer's send-disabled logic and Conversation both read `runs[chatId]`, so the leftover entry must not disable Send. Tested on the mock, so it goes with S0-N3. | needs-design | no |
| S7-N2 | `.svg` classified as image: refused, or dropped with the vision message (**merges S0-N5**) | minor | `src/renderer/features/composer/attachments.ts` `isImageFile` (l.12, used at l.61); `src/renderer/lib/mock-api-client.ts` `uploadAttachment` (l.312); composer + mock tests | Root cause shared with S0-N5: "image" is decided by an `image/*` prefix instead of `IMAGE_MIME_TYPES`. Use `IMAGE_MIME_TYPES` in both places. No shared-constant change. | mechanical | no |
| S7-N3 | Queued tool calls show a spinner before their `tool_call` event | minor | `src/renderer/features/conversation/turns.ts` `TurnOptions`, `buildTurns` (l.57, 93), `ToolState`, `isWaiting` (l.106); `Conversation.tsx` (l.33); tool row component; `Conversation.test.tsx` (l.72) | Adds `runningToolIds` to `TurnOptions` and probably a `queued` `ToolState` (which `isWaiting` and the tool row must handle). Same files as S7-N1. Default visual: muted icon, no spinner. | needs-design | no |

### S8: Electron and packaging

| ID | Title | Sev | Files / functions | Dependencies | Label | Sec |
|---|---|---|---|---|---|---|
| S8-N1 | Key saved without a keyring stays plaintext after the keyring returns | minor | `src/main/safe-storage-secret-store.ts` `SafeStorageSecretStore.get` (l.41) / `createSecretStore` (l.80–95); its test | No interface change if it migrates at startup or in `get` under the file lock. Surfacing "stored unencrypted" in the UI would change `PublicSettings` (see Q3). | mechanical | **yes** |
| S8-N2 | AppImage's built-in desktop entry launches with `--no-sandbox` | minor | `electron-builder.yml` (`linux.executableArgs: []`); `src/main/index.ts` (warn on `hasSwitch('no-sandbox')`) | Same file as S8-N3 (`main/index.ts`), so same batch | mechanical | **yes** (Chromium sandbox) |
| S8-N3 | Dev, preview and the installed AppImage share one Electron profile and lock | minor | `src/main/index.ts` (before `requestSingleInstanceLock`, l.15) | Must not override an explicit `--user-data-dir`: `scripts/e2e/run-electron.sh:27` passes one *and* sets `HARNESS_DATA_DIR`, so a naive `setPath` would break the S9 e2e isolation. Dir name and preview-mode handling are design choices (default `~/.config/harness-dev`). README may need a line. | needs-design | **yes** (real key typed into the dev instance; profile isolation) |
| S8-N4 | `install-local.sh` exits 1 silently when `release/` is missing | minor | `scripts/install-local.sh` (l.39) | None | mechanical | no |

### S9: e2e and docs

| ID | Title | Sev | Files / functions | Dependencies | Label | Sec |
|---|---|---|---|---|---|---|
| S9-N1 | "A15 after restart" check always passes | minor | `scripts/e2e/smoke.mjs` main phase (A15, ~l.714–735) and persist phase (l.916–919); `state.json` | None | mechanical | no |
| S9-N2 | README claims e2e covers A1–A18; A12 offline and the A5 spinner/`list_files` aren't covered | minor | `README.md` (l.103, l.131–133); optionally `smoke.mjs` (`[fake:error=network_error]` case) | Same file as S9-N1 if the script case is added. Default: add the network_error case, document the A5 spinner/`list_files` as manual, and add the keyring prerequisite. | mechanical | no |
| S9-N3 | `run-electron.sh` fails if `ELECTRON_RUN_AS_NODE` is set | minor | `scripts/e2e/run-electron.sh` `start_app` (l.25) / top of script | None | mechanical | no |

---

## Merged duplicates

| Kept | Merged | Root cause |
|---|---|---|
| S7-N2 | S0-N5 | The renderer decides "image" by the `image/*` MIME prefix instead of `IMAGE_MIME_TYPES`, while the server sniffs `.svg` as text. Same bug in the composer (real client) and the mock. |

Related but **not** merged (different root causes): S2-N1 / S6-N3 / S0-N2 (three different sources of misleading network-error copy); S1-M1 / S8-N3 (both involve the dev data dir, but one is sandbox containment and the other is profile isolation); S0-N3 / S7-N1 (both about Stop, but one is mock fidelity and the other is store state; batched together).

---

## Work batches

### Phase 2: majors and needs-design (sequential)

Planner: Opus 5.5 (medium). Implementer: Sonnet 5.5 (medium), or Opus 5.5 (medium) when the batch is security-sensitive. Mechanical minors that edit the same function or file as a batch's major ride along, so no Phase 3 batch has to touch that file again.

| # | Batch | Findings | Files | Impl | Notes |
|---|---|---|---|---|---|
| B1 | Walker `.gitignore` hardening | S3-M1 | `core/tools/walk.ts`, tools tests | **Opus** | Goes first: B2 option B also edits `walk.ts`. |
| B2 | Project root vs data dir | S1-M1, S1-N1 | `core/storage/projects.ts`, `storage/index.ts`, `projects.test.ts` (+ option B: `tools/sandbox.ts`, `walk.ts`, `tools/index.ts`, core wiring) | **Opus** | Q1 = (b): sandbox/walker deny + reject roots inside the data dir. |
| B3 | SSE early disconnect | S5-M1 | `server/sse.ts`, server route tests | Sonnet | Repro: slow `models.get` + image, abort during validation. |
| B4 | Settings key flow | S6-M1, S6-N2, S6-N3 | `features/settings/SettingsModal.tsx`, `SettingsModal.test.tsx` | **Opus** | All three edits are in one file. |
| B5 | Agent history without tools | S4-M1, S4-N1, S4-N2 | `core/agent/history.ts`, `loop.ts`, `system-prompt.ts`, their tests | Sonnet | One planner decides the flattened tool-call format and the no-tools prompt with the tree. |
| B6 | Renderer run lifecycle (Stop, tool states) | S7-N1, S7-N3, S0-N3 | `stores/runs.ts`, `features/conversation/turns.ts`, `Conversation.tsx`, tool row component, `lib/mock-api-client.ts` (stream/pause only), `runs.test.ts`, `Conversation.test.tsx`, `mock-api-client.test.ts` | Sonnet | Fix the mock's Stop first, so the store tests run against real-client semantics. |
| B7 | Electron profile isolation and sandbox | S8-N3, S8-N2 | `main/index.ts`, `electron-builder.yml` (+ README dev note) | **Opus** | Keep `--user-data-dir` working for the e2e. |

### Phase 3: mechanical (parallel, one worktree each; no two batches share a file)

| # | Findings | Files | Sec |
|---|---|---|---|
| P1 | S0-N1 | `.gitignore` — **done early (fixed in f4ec622)** so every batch can run lint | no |
| P2 | S0-N4 | `vitest.config.ts`, new `src/renderer/test-setup.ts` | no |
| P3 | S0-N2 | `renderer/lib/http-api-client.ts` + its test | no |
| P4 | S7-N2 (+S0-N5) | `features/composer/attachments.ts`, `lib/mock-api-client.ts` (`uploadAttachment` only), composer test, `mock-api-client.test.ts` | no |
| P5 | S1-N2 | `core/storage/chats.ts`, `chats.test.ts` | no |
| P6 | S1-N3 | `core/storage/attachments.ts`, `attachments.test.ts` | no |
| P7 | S2-N1, S2-N2, S2-N3, S2-N4 | `core/providers/openrouter.ts`, `openrouter.test.ts` | **yes** (S2-N1) |
| P8 | S3-N1 | `core/tools/read-file.ts`, `tools.test.ts` | no |
| P9 | S5-N1 | `server/middleware/security.ts`, `security.test.ts` | **yes** |
| P10 | S6-N1 | `stores/ui.ts`, `components/ui/Dialog.tsx`, their tests | no |
| P11 | S8-N1 | `main/safe-storage-secret-store.ts` + test | **yes** |
| P12 | S8-N4 | `scripts/install-local.sh` | no |
| P13 | S9-N1, S9-N2, S9-N3 | `scripts/e2e/smoke.mjs`, `scripts/e2e/run-electron.sh`, `README.md` | no |
| P14 | S2-G1 | `package.json` (new script), plan doc | no |

P4 and B6 both edit `mock-api-client.ts`, in different functions. B6 runs in Phase 2, so P4's worktree branches from code that already has it. P8 and B1 share `tools.test.ts` the same way.

---

## Decisions (2026-11-02)

- Q1 → (b): deny the data dir in the tool sandbox and walker, and also reject project roots that sit inside the data dir.
- Q2 → (b): add an npm script using `--tsconfig tsconfig.node.json` and update the plan text.
- Q3 → no UI change in V0; migrate plaintext to safeStorage and log it.
- Q4 → Opus 5.5 (medium) implements P7, P9, P11.
- All listed defaults accepted.

## Questions for the user (answered above)

1. **S1-M1 (blocks B2): how do we keep the data dir out of a project's reach?**
   - (a) Reject at project creation any root that contains the data dir or sits inside it. This is simple, but the harness repo can no longer be a project in dev (it contains `./.dev-data`), and in prod neither can `~` or `~/.config`. Projects that are already saved stay exposed.
   - (b) Deny the data dir inside the tool sandbox and walker. Those folders stay usable as projects, and existing projects are covered too, but it changes `resolveInProject`/`walk` options.
   - (c) Both.
   - *Recommendation:* (b), plus rejecting roots that sit *inside* the data dir.
2. **S2-G1: the plan's command `npx tsx scripts/try-openrouter.ts` fails.**
   - (a) Add `paths` to the root `tsconfig.json`.
   - (b) Leave the configs alone, add an npm script that uses `--tsconfig tsconfig.node.json`, and change the plan text to match.
   - (c) wontfix: the S2 notes already document the working form.
   - *Recommendation:* (b).
3. **S8-N1 follow-up: should Settings show that the key is stored unencrypted?** Today the only sign of the plaintext fallback is a console line. The finding itself (re-encrypt once a keyring is available) needs no decision. Surfacing the state in the UI would add a field to `PublicSettings`, a shared type.
   - *Recommendation:* not in V0. Migrate and log only.
4. **Model for security-sensitive items in Phase 3** (S2-N1, S5-N1, S8-N1). Your Phase 3 rule says Sonnet, but Phase 2 sends security-sensitive work to Opus.
   - *Recommendation:* Opus 5.5 (medium) for P7, P9 and P11; Sonnet for the rest.

Defaults I'll use unless you say otherwise (none of these needs a decision): S4-N2 renders the tree, as the spec says. S7-N3 shows queued tools muted with no spinner. S6-N2 uses a fixed "Show key" label with `aria-pressed`. S6-N3 shows a failed Remove inside the confirm. S8-N3 uses `~/.config/harness-dev` and respects `--user-data-dir`. S9-N2 adds the network_error e2e case and documents the rest as manual. S0-N1 ignores `.claude/worktrees/`.

---

## Phase 4 verification (2026-11-02, HEAD after all merges)

An independent verifier, who wrote none of the fixes, re-checked every ID against the combined diff `ad1cf46..HEAD`. It re-ran the reviewers' repros where practical and reverted fixes in a scratch worktree to confirm each regression test fails without its fix.

- **34 resolved, 1 partial (S8-N3), 0 not resolved.**
- **Regression found and fixed:** the S6-N1 focus fallback moved focus to the composer behind a still-open Settings modal (Settings → Remove key → confirm). Fixed in `2b2fedf` with a test.
- **Final state:** `npx vitest run` 571 passed / 1 skipped (baseline 491); typecheck and lint clean; `npm run e2e` passed on the merged code before the last fix (web 78+11, Electron 79+11).

### Open questions / follow-ups (not fixed)
1. **S8-N3 partial:** a *packaged* app started with `HARNESS_DATA_DIR` still shares `~/.config/harness` and the single-instance lock with the installed app. This was the B7 planner's default. The `index.ts` `setPath` wiring is covered only through the pure helper.
2. **S1-M1 follow-up:** each instance denies only its own data dir. A `preview` run with the harness repo as a project could still read dev's plaintext `./.dev-data/secrets.json`, and a dev run with `~` as a project could reach `~/.config/harness`. Option: also deny `.dev-data*` by name, and/or the default prod userData path.
3. **Tool calls when no tools were offered:** if a model emits tool calls anyway, the next step in the same turn still sends tool content (`loop.ts` ~l.250).
4. **`renderTree` has no abort or timeout.** A stalled network mount could hang a turn. It now also runs for non-tool project chats (S4-N2).
5. **image/* outside IMAGE_MIME_TYPES** (bmp/tiff/heic) now go to the server as text, where sniffing rejects them. The mock accepts them, which is a small mock/server mismatch in the opposite direction from S0-N5.
6. **Minor leftovers:** the `scripts/try-openrouter.ts` header comment shows the old usage. The S9-N1 `expandedProjects` comparison is weak, because the row is flipped back before the snapshot; the collapsed-sidebar assertion carries the check. S4-N1's re-read and write are not atomic (accepted default). A hardlink to `secrets.json` inside a project isn't caught by the path-based deny.
7. **Out of scope:** S9.2 (manual runs on CachyOS/Arch and the AppImage) and S9.5 (tag `v0.1.0`).
