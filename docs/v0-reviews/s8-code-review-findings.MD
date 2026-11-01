# S8 code review findings

Reviewed branch `V0` at `ad1cf46`. The S8 files have no uncommitted changes.
Model: Claude Opus 5.5, effort max.

## Summary

S8 meets its acceptance bar for the code I could inspect. Window hardening is complete. The `app://` handler keeps static files inside the renderer build and passes `/api` responses through untouched, so nothing is buffered and the `cancel` → `onAbort` path still works. `SafeStorageSecretStore` writes only base64 ciphertext, with mode 0600. I found four minor issues:

- a plaintext key saved in a launch without a keyring is never encrypted later;
- the AppImage's built-in desktop entry turns off the sandbox;
- dev and preview share the installed app's Electron profile and single-instance lock;
- `install-local.sh` fails silently before the first `npm run dist`.

What I ran: the `src/main` unit tests (13 pass), `install-local.sh` against temporary HOME dirs, and path-traversal probes against `serveRenderer`. I did not run `npm run dist`, launch Electron or the AppImage, or test against a real KWallet.

## Findings

### [minor] A key saved without a keyring stays plaintext after the keyring comes back

ID: S8-N1

Status: open

- Location: `src/main/safe-storage-secret-store.ts:41` (read path); fallback chosen in `createSecretStore` at `:88-95`
- Problem: the trigger is any launch where `isEncryptionAvailable()` is false. Examples: KWallet is disabled, its unlock prompt is cancelled, there is no session D-Bus, or the desktop gets `basic_text`.
  - In that launch, `createSecretStore` returns `FileSecretStore`, and a key saved then is written as `enc: 'plain'`.
  - An existing encrypted key ends up the same way. The fallback store cannot read it, the UI asks for the key again, and saving it overwrites the ciphertext with plaintext.
  - On later launches with a working keyring, `get` returns the plain value and nothing encrypts it. The only `set` call is a user replacing the key (`settings.ts:51`), so the file stays plaintext indefinitely.
- Why it matters: one passing keyring failure permanently breaks the S8 acceptance condition ("the key in `secrets.json` is encrypted"). The UI gives no sign of it. The only trace is a console line, which nobody sees when the app is launched from the menu.
- Direction: when safeStorage is available, encrypt any `enc: 'plain'` entry once at startup (or in `get`, under the file lock) and log that it happened. Extend the existing "reads a plain entry" test to check that the file says `enc: 'safeStorage'` afterwards.

### [minor] The AppImage's built-in desktop entry launches with `--no-sandbox`

ID: S8-N2

Status: fixed in b62de57

- Location: `electron-builder.yml:23-32`
- Problem:
  - The config sets neither `toolsets.appimage` nor `executableArgs`. electron-builder 26.18 then defaults to `["--no-sandbox"]` for the `.desktop` file inside the AppImage (`node_modules/app-builder-lib/out/targets/appimage/AppImageTarget.js:27`), giving `Exec=AppRun --no-sandbox %U`.
  - Trigger: the user integrates `harness-*.AppImage` with AppImageLauncher or Gear Lever instead of `install-local.sh`. Both tools reuse that entry, so every launch from the menu runs with Chromium's sandbox off.
  - Separately, the generated AppRun silently adds `--no-sandbox` whenever `unshare -Ur true` fails (`appImageUtil.js:207-225`).
- Why it matters: S8.6 and §3.3 require the sandbox. With `--no-sandbox`, the renderers that display model output, markdown and images lose the OS sandbox, and the user is not told. The §10 "check on the Arch install" for user namespaces cannot catch this, because the app starts either way.
- Direction: set `executableArgs: []` under `linux:` (or `appImage:`), so the built-in entry becomes `AppRun %U`. In main, log a warning when `app.commandLine.hasSwitch('no-sandbox')` is set, so the AppRun fallback is visible. The desktop entry that `install-local.sh` writes is already correct.

### [minor] Dev, preview and the installed AppImage share one Electron profile and one single-instance lock

ID: S8-N3

Status: fixed in b62de57

- Location: `src/main/index.ts:15`
- Problem:
  - `requestSingleInstanceLock()` and Chromium's profile both live in Electron's `userData` folder.
  - That folder is `~/.config/harness` for `npm run dev`, `npm run preview` and the AppImage alike. All three run under the app name `harness`, and electron-vite starts `electron .` with no `--user-data-dir`. `HARNESS_DATA_DIR` only moves harness's own files.
  - Trigger 1: while the installed harness is open, run `npm run preview` (or `npm run dev`). It loses the lock, quits, and brings the release window to the front.
  - Trigger 2: while `npm run dev` is running, launch harness from the KDE menu. That brings up the dev window, whose backend stores the key in plaintext in `./.dev-data/secrets.json`.
- Why it matters:
  - The S8.11 preview cannot run while the installed app is open.
  - A developer may change real `~/.config/harness` data, or type the real key into the dev instance, while believing they are in the other mode.
  - Preview and release also share `app://harness` localStorage.
  - The e2e script avoids all of this only because it passes `--user-data-dir`.
- Direction: when `!app.isPackaged` or `HARNESS_DATA_DIR` is set, call `app.setPath('userData', …)` with a separate directory for that mode before `requestSingleInstanceLock()`. Examples: `~/.config/harness-dev`, or a folder derived from `HARNESS_DATA_DIR`.

### [minor] `install-local.sh` exits 1 with no message when `release/` does not exist

ID: S8-N4

Status: open

- Location: `scripts/install-local.sh:39`
- Problem:
  - Because of `set -euo pipefail`, `find "$repo/release" … 2>/dev/null` fails when `release/` is missing. The assignment then fails and the script exits before it reaches the "Run 'npm run dist' first." check.
  - Trigger: running the script in a fresh checkout before the first `npm run dist`.
  - Reproduced with a temporary HOME: exit 1, no output. The message only appears when `release/` exists but is empty.
- Why it matters: the documented first-run path fails silently.
- Direction: add `|| true` to that pipeline, or test `[ -d "$repo/release" ]` first, so the existing error message is reached.

## Requirement gaps

None.

The README still lists two checks as manual: launching from the KDE launcher after `install-local.sh`, and running the AppImage on Arch. Those are S9.2 verification, not gaps in the S8 code.

## Checked and sound

- **`SafeStorageSecretStore`:**
  - `encryptString` output is stored as base64 with `enc: 'safeStorage'`.
  - `set` replaces the whole entry, so no plaintext sits beside the ciphertext.
  - Writes go to a temp file opened with `wx` at 0600, then fsync, then rename.
  - A failed decrypt returns `null` and logs only the secret's name and Electron's error message.
  - Empty names and `version` are rejected, and unknown `enc` values fail the schema.
  - The `FileSecretStore` fallback refuses `safeStorage` entries instead of misreading them.
  - The store is chosen after `ready`, and `basic_text`/`unknown` backends count as unavailable.
  - The data dir is `HARNESS_DATA_DIR` if set, otherwise `userData`. Nothing in `src/main` logs the key.
- **`app://` handler:**
  - Scheme privileges match S8.3 exactly and are registered before `ready`.
  - Hosts other than `harness` get 403.
  - `/api` and `/api/*` go to `api.fetch(request)`, and the `Response` comes back untouched. Hono's `cancel` → `onAbort` chain is intact, and nothing buffers or aborts a body early, consistent with §10.
- **Static files:**
  - Only GET and HEAD are served.
  - Traversal probes all stayed inside the root or got 403/404: `..`, `%2e%2e`, `.%2e`, `..%2f`, `%5c`, `%00`, `//etc/passwd`, and a sibling folder sharing the root's name prefix.
  - The SPA fallback applies only to paths without an extension.
  - The S8.3 CSP is sent verbatim on every HTML response, including the fallback, and `nosniff` is sent on all responses.
- **CSP and the build:** the S9 `assetsInlineLimit` change keeps every `.woff2` as a file, and all three fontsource packages ship only woff2. The renderer has no eval, wasm, workers or `blob:` fetches that the CSP would block.
- **Window hardening:**
  - `contextIsolation` and `sandbox` are on; `nodeIntegration` is off.
  - `window.open` is always denied; only http(s) URLs go to `shell.openExternal`.
  - `will-navigate` and `will-redirect` compare `scheme://host`, which is correct for the custom scheme, and block everything else. Webviews are blocked.
  - Markdown and Settings links use `target="_blank"`, so they go through the window-open handler.
  - The IPC handler checks the sender frame's origin.
  - The preload exposes only `isElectron` and `pickDirectory` and is built as CommonJS (`index.cjs`), which I checked against electron-vite's preload defaults.
- **Lifecycle:**
  - The lock is taken before `ready`, and `second-instance` restores and focuses the window.
  - The window is 1440×900 (min 800×600) with background `#161316` and title `harness`, and is shown on `ready-to-show`.
  - The dev menu is kept; the prod menu is removed.
  - A backend failure shows an error box and exits with code 1.
  - The protocol handler is registered before the window loads.
- **Packaging:** `electron-builder.yml` matches every S8.9 field. It ships only `out/**` and `package.json`, without source maps. The main bundle inlines its dependencies; `electron` and Node built-ins stay external.
- **`install-local.sh`** (run against temporary HOME dirs):
  - Running it twice works.
  - The AppImage is replaced via a temp file and `mv`.
  - `sort -V` picks 0.10.0 over 0.0.0.
  - `--uninstall` removes exactly the three installed files and leaves `~/.config/harness` alone.
  - The desktop entry has `StartupWMClass=harness` and no `--no-sandbox`.
- **Icon:** 512×512 RGBA: an accent-coloured rounded square with the design's spark glyph path in `#161316`.
- **Spike:** matches §10. Delivery is incremental, and on abort the stream's `cancel()` fires but `request.signal` does not.
