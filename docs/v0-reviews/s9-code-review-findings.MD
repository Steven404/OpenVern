# S9 code review findings

Reviewed branch `V0` at `ad1cf46`.
Model: Claude Opus 5.5, effort high.

## Summary

The e2e harness is sound for the automated parts. It uses temporary data, Chromium profile and Electron userData directories. It cleans up its process groups. Any failed check, aborted section, crash or console error makes the script exit non-zero. It only ever uses a fake key. The README matches the code on install, dev, build, data dir, key storage and limits. There are three small problems. One restart check always passes, so it proves nothing. The README claims more e2e coverage than the scripts provide. The Electron runner fails when its parent environment sets `ELECTRON_RUN_AS_NODE`. None of these blocks S9 for the code parts. The only open S9 items are the manual ones.

## Findings

### [minor] The "A15 after restart" check always passes, whatever is stored

ID: S9-N1

Status: open

- Location: `scripts/e2e/smoke.mjs:916-919`
- Problem: The persist phase checks "sidebar visible after restart (was expanded)" by testing only that `aside` exists. Expanded is also the default (`sidebarCollapsed` is false unless `localStorage` says otherwise; `src/renderer/stores/ui.ts`). The check therefore passes even if the browser profile or Electron userData `localStorage` was lost or never written. One real trigger: Electron is stopped with SIGTERM (`stop_bg`) before Chromium writes `localStorage` to disk. Project expansion is not checked after the restart at all.
- Why it matters: The comment and the README (lines 93–94) say UI state survives a restart, and this check is the only evidence offered. It is a false green.
- Direction: Collapse the sidebar, or flip a project row, at the end of the main phase so the saved state differs from the default. Record it in `state.json` and assert that state in the persist phase.

### [minor] The README claims e2e covers A1–A18, but some parts are neither automated nor on the manual list

ID: S9-N2

Status: open

- Location: `README.md:103`, `README.md:131-133`
- Problem: The Tests table says `npm run e2e` covers "checklist items A1–A18". The limitations section names the remaining manual items: real key, native picker, KDE launcher, AppImage on Arch. Some parts are missing from both:
  - **A12:** "offline → network error with Retry" is not exercised. The script uses `[fake:flaky]`, which is a `provider_error`, although `[fake:error=network_error]` exists.
  - **A5:** the `list_files` row and the spinner are not asserted. The fake provider only calls `read_file`.

  The README also says the Electron half needs only a display. Its `secrets.json uses enc: safeStorage` check also needs a working keyring. Under Xvfb or a session with no KWallet or libsecret, the run fails without explanation.
- Why it matters: S9.2 sign-off depends on knowing which checklist items were actually automated. The current text suggests everything else is green.
- Direction: Name the A12 offline path, the A5 spinner and `list_files` as manual, or add a `[fake:error=network_error]` case to the script. Add "and a keyring (KWallet/libsecret)" to the Electron-half prerequisite.

### [minor] `run-electron.sh` fails if `ELECTRON_RUN_AS_NODE` is set in the environment

ID: S9-N3

Status: open

- Location: `scripts/e2e/run-electron.sh:172-173`
- Problem: The script starts `node_modules/electron/dist/electron .` with the caller's environment unchanged. When the parent process exports `ELECTRON_RUN_AS_NODE=1`, Electron runs `out/main` as plain Node. It never opens an `app://` page, and the script waits 40 s before failing with a confusing `electron.log`. I confirmed this: this agent session exports the variable, and a probe app run there executed as Node. With the variable unset, the same probe started normally and reported `userData` = the `--user-data-dir` path. Electron-based IDEs and agent hosts commonly set this variable.
- Why it matters: The Electron half of `npm run e2e` cannot run from the agent sessions that drive this repo's sections. It fails loudly, so this is not a false pass, but it wastes a run and points at the wrong cause.
- Direction: Unset the variable for the launched app in `start_app`, for example with `env -u ELECTRON_RUN_AS_NODE` or `unset ELECTRON_RUN_AS_NODE` near the top of the script.

## Requirement gaps

- S9.2 (manual §8 runs on CachyOS and Arch, including the AppImage) and S9.5 (tag `v0.1.0`) are still open.
- Nothing else. S9.1, S9.3 and S9.4 are satisfied by the current files, apart from the README coverage wording above.

## Checked and sound

- **Data isolation:** `HARNESS_DATA_DIR="$OUT/data"` is honored by both `dev.ts` and `main/backend.ts` (`resolveDataDir`). I confirmed empirically that Electron honors `--user-data-dir`, so `localStorage` and the single-instance lock stay in `$OUT/userdata`, never `~/.config/harness`. Chromium uses `$OUT/chrome-profile`. Only the fake key `sk-or-v1-0123456789abcdefa1b2` is used, and no real key is read or logged.
- **Process handling in `lib.sh`:** each `setsid` process becomes its own group because non-interactive bash does not give background jobs their own process group. The EXIT/INT/TERM traps kill every recorded group with TERM and then KILL. `stop_bg` waits for the old process to exit before the A18 restart. The scratch dir is kept on failure, with `E2E_KEEP=1`, or when `E2E_OUT_DIR` is set. Preconditions (busy port, no Chromium, no display, no Electron binary) exit before `e2e_init`.
- **Failure propagation:**
  - `check(false)`, an aborted `section()`, a top-level exception or any console or page error each make `smoke.mjs` exit 1.
  - The runners collect `RC` across phases, and `npm run e2e` chains the two halves with `&&`.
  - In `shots.mjs`, overflow or console problems also exit 1.
  - "PASS after waitFor" checks are not vacuous, because `waitFor` throws on timeout.
- **Assertions that match real behavior:**
  - **A7:** the expected texts match `OUTSIDE_MESSAGE` and `BLOCKED_MESSAGE` in `sandbox.ts`, and the check verifies the stored tool result plus the absence of `do-not-leak`.
  - **A5:** the "expands" check waits for "Demo project", which only appears in the tool output, not in `FINAL_ANSWER`.
  - **A18:** the restored model (Haiku or DeepSeek) differs from `DEFAULT_MODEL` (Sonnet), so that check is not vacuous.
  - **A2:** the invalid-key text matches the fake `validateKey`.
- **Fake provider markers:** `[fake:slow|error|flaky|read]` are used as `fake.ts` implements them.
- **README claims checked against the code:**
  - ports 8787 and 5173 (`strictPort`)
  - `HARNESS_FAKE_PROVIDER` in the prod wiring
  - `preview` data dir and the AppImage artifact name
  - data-dir layout: `index.json` rebuild, attachment `.bin`/`.json`, 1-hour model cache
  - key hint format `sk-or-v1-…a1b2`
  - safeStorage `enc` and the logged plaintext fallback (weak backends count as unavailable)
  - attachment limits (512 KB / 10 MB / 10 files, PNG/JPEG/WebP/GIF)
  - 800×600 minimum window and the 760 px overlay
  - minified renderer, Node ≥22 engine
  - the `e2e`, `e2e:web` and `e2e:electron` script wiring in `package.json`
