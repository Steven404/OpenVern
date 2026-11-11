# OpenVern

A desktop app to chat with LLMs about your local code projects. It talks to [OpenRouter](https://openrouter.ai)
only, lets the model **read** a project (list, read and search files) and **propose edits** (create, edit, delete)
through tool calls, and runs both in a browser (dev) and as a desktop app: a Linux AppImage, or a locally built app on
macOS (Apple Silicon). It cannot run commands.

The plans, contracts, work sections and acceptance checklists are in [`docs/v0-plan.md`](docs/v0-plan.md) and
[`docs/v0.2-plan.md`](docs/v0.2-plan.md).

## Edits and review (v0.2)

In a chat that belongs to a project, with a tools-capable model, the agent has three more tools: `write_file`,
`edit_file` and `delete_file`. **They never touch your disk.** Each call stages a *proposal* in the chat's change set
(`<dataDir>/changes/<chatId>.json`); the agent's own later reads see its proposals, yours see the files as they are.

1. A **Proposed edits** card appears under the assistant turn.
2. Open the right panel (header button or `Ctrl+]`), then **Diff** (or press "Review changes" on the card). Every
   changed file is shown as unified or split hunks. Accept or Reject each hunk (Undo to change your mind), or use
   Accept all / Reject all, then **Apply N**. With every hunk rejected the button becomes **Discard**.
3. Apply writes exactly the accepted hunks. The card turns into **Edits applied**. A file you changed on disk after
   the proposal is skipped and listed as "Changed on disk" (never merged); the other files still apply.
4. At your next message the model is told what was written, rejected, skipped or still pending. Retrying a turn puts
   the proposal back to what it was before that turn. Applied edits are not undoable from the app (use git).

The right panel has **Files** (read-only tree of the project with a filter, file tabs with line numbers and an Attach
button; `.env`, keys and `.git` are hidden), **Terminal** (always disabled in 0.2) and **Diff** (disabled until the
chat has proposed edits). Files and Diff are disabled in chats without a project, which also get no edit tools. Split
view needs room: it is disabled when the window is too narrow for the wider panel next to the conversation.

Writes use the same sandbox as reads (no absolute paths, `..`, symlink escapes, `.env*`, keys, `.git/`, the data dir),
are re-checked when applying, and go through a temp file and `rename`.

Limits: a staged file is at most 256 KB of UTF-8 text (`writeFileMaxBytes`), a chat has at most 50 pending files
(`pendingFilesPerChat`), the Diff pane shows at most 5000 lines per file (`diffMaxLinesPerFile`, larger files can't be
applied from the pane) and the viewer opens files up to 1 MB. The window can't be smaller than 1080×720.

## Prerequisites

- macOS on Apple Silicon (arm64), macOS 13 or later: see [macOS (Apple Silicon)](#macos-apple-silicon)
- Linux x86_64 (developed on CachyOS / Arch, KDE Wayland)
- Node.js 22 or newer, npm 10 or newer
- `fuse2` to run the AppImage, and unprivileged user namespaces for Chromium's sandbox (enabled on Arch / CachyOS kernels)
- An [OpenRouter API key](https://openrouter.ai/keys) to chat for real. Not needed with the fake provider or the mock API (see below)
- For `npm run e2e` (web half): a Chromium, either Playwright's (`npx playwright install chromium`), one on `PATH`, or
  `E2E_CHROME=/path/to/chrome`. The Electron half needs a display and a keyring (KWallet/libsecret)

## Install

```bash
npm ci
```

Electron's binary may not be downloaded by `npm ci`. If `npm run dev` or `npm run preview` complain that it is
missing, fetch it with:

```bash
node node_modules/electron/install.js
```

## Run it

| Command | What you get |
|---|---|
| `npm run dev:web` | API server on `http://127.0.0.1:8787/api` plus the renderer in your browser at `http://localhost:5173` (Vite proxies `/api`). Data in `./.dev-data`. |
| `npm run dev` | The same API server plus an Electron window on the Vite dev server (DevTools, hot reload). Data in `./.dev-data`. |
| `npm run dev:server` | API server only (`tsx watch`). |
| `npm run preview` | Builds, then runs Electron on the **production wiring** (`app://openvern/`, backend inside the main process). Data in `./.dev-data-preview`. |

Ports 8787 (API) and 5173 (Vite, strict) are fixed; stop other dev servers first.

Environment variables:

| Variable | Effect |
|---|---|
| `OPENVERN_FAKE_PROVIDER=1` | The dev server (and the production wiring, so also `preview` and the AppImage) uses a scripted fake provider instead of OpenRouter: any key starting with `sk-or-` is accepted, no network, no cost. Replies read `README.md` with a `read_file` call, then answer with a code block. Test markers in a message: `[fake:slow]` (slow stream, to try Stop), `[fake:error=<code>]` (the call fails with that error code, e.g. `invalid_api_key`, `provider_error`) `[fake:flaky]` (fails once, succeeds on Retry), `[fake:read=<path>]` (the first tool call reads that path, e.g. `.env`, to see the sandbox refuse it) and, in a project chat, `[fake:edit=<path>]` / `[fake:write=<path>]` / `[fake:delete=<path>]` (propose that change; several markers propose several files). |
| `OPENVERN_DATA_DIR=<dir>` | Overrides the data directory in every mode. |
| `VITE_API=mock` | The renderer uses an in-memory mock API (seeded sample data, fake streaming); no server needed. E.g. `VITE_API=mock npm run dev:web`. |

Typical keyless session: `OPENVERN_FAKE_PROVIDER=1 npm run dev:web`, open Settings, paste any `sk-or-…` key.

## Build and install

The Linux commands in this section are unchanged. They have not yet been re-run on the macOS-port branch.

```bash
npm run build           # main, preload and renderer into out/ (the renderer bundle is minified)
npm run dist            # build + package release/OpenVern-<version>-x86_64.AppImage
scripts/install-local.sh              # install the newest AppImage for your user
scripts/install-local.sh --uninstall  # remove what it installed
```

`install-local.sh` copies the AppImage to `~/.local/bin/openvern.AppImage`, the icon to
`~/.local/share/icons/hicolor/512x512/apps/openvern.png` and writes `~/.local/share/applications/openvern.desktop`
(then refreshes the desktop database if the tool exists). It also removes the `harness.*` files a 0.1 install left behind (on install and on `--uninstall`). It is idempotent. Run `openvern.AppImage` from a terminal
to see the logs.

## macOS (Apple Silicon)

OpenVern runs natively on Apple Silicon Macs. Intel and universal builds are not supported. Tested on macOS 26.6 (arm64).

### Requirements

- Apple Silicon (arm64) with **macOS 13 or later**. The locked Electron 45.2.1 declares 13.0 as its minimum.
- Node.js 22 or newer, arm64 build (not under Rosetta). The validation used Node 24.13.0 (arm64).
- A logged-in GUI session for the Electron e2e runs (`npm run e2e:electron`, `npm run e2e:packaged`). Both refuse a plain SSH session.

### Run from source

Install and run exactly as above (`npm ci`, `npm run dev:web`, `npm run dev`, `npm run preview`). On macOS:

- **`npm run dev` and `npm run dev:web` don't use the Keychain.** The backend runs in the Node dev server with the file
  store, so the key sits in `secrets.json` (mode 0600), as on Linux. Use `OPENVERN_FAKE_PROVIDER=1` for keyless runs.
- **`npm run preview` and the packaged app use the macOS Keychain.** They read or create the login item
  `OpenVern Safe Storage`, so macOS may show a Keychain prompt. Answer it. Choose **Always Allow** to avoid repeated
  prompts.
- The browser e2e (`npm run e2e:web`) finds Playwright's Chromium in `~/Library/Caches/ms-playwright`. Set
  `E2E_CHROME=/path/to/browser` to use another one.
- Shortcut labels show ⌘ on macOS and Ctrl on Linux. Both Cmd and Ctrl shortcuts work.

### Build and install locally

```bash
npm run dist:mac
scripts/install-local-mac.sh              # install to ~/Applications/OpenVern.app
scripts/install-local-mac.sh --uninstall  # remove the installed app
```

- `npm run dist:mac` builds `out/` and writes `release/OpenVern-<version>-arm64.dmg` and
  `release/mac-arm64/openvern.app`. The app is arm64 only, **ad-hoc signed** (`identity: "-"`), **not notarized**, and
  built without the hardened runtime.
- A locally built app carries no quarantine attribute (only `com.apple.provenance`), so Gatekeeper doesn't block it.
  Nothing in this repository removes quarantine.
- `install-local-mac.sh` copies the newest `release/mac-arm64*/*.app` to `~/Applications/OpenVern.app`. It is idempotent.
  It refuses to replace the app while OpenVern is running. It never runs `sudo`, `xattr`, `spctl` or `codesign`, and it
  never touches your data or the Keychain. Set `OPENVERN_INSTALL_DIR=<dir>` to install somewhere else.
- `--uninstall` removes only the installed app. It prints two things to remove by hand if you want them gone: the data
  directory `~/Library/Application Support/openvern`, and the Keychain item `OpenVern Safe Storage`.
- **Rebuilds and the Keychain.** In one measured run on macOS, repeated builds with unchanged inputs kept the same code
  hash. A build with changed contents got a new ad-hoc signature and prompted once for `OpenVern Safe Storage`, then
  read the stored key. Future changed builds may prompt again. Whether macOS re-asks for folder access after a rebuild
  hasn't been measured.

### Packaged end-to-end test

```bash
E2E_APP=/path/to/validation/openvern.app npm run e2e:packaged
```

- `npm run e2e:packaged` runs the smoke, restart, persistence, edits and archive checks against a packaged `.app`. It
  uses the fake provider and temporary data. It does not build the app, so run `npm run dist:mac` or a validation build
  first.
- Without `E2E_APP` it looks for a validation package at a fixed temporary path and exits with a hint if none is there.
- It **refuses the real identity** (bundle id `dev.stefanos.openvern` or name `OpenVern`) unless
  `E2E_ALLOW_REAL_IDENTITY=1` is set, because a real-identity run would read or create the real `OpenVern Safe Storage`
  item. For routine runs, build a validation package with its own bundle id and product name, in the same form as the
  validation build:

  ```bash
  npx electron-builder --mac dir --arm64 \
    -c.appId=dev.example.openvern.validation \
    '-c.productName=OpenVern Validation' \
    '-c.extraMetadata.productName=OpenVern Validation' \
    -c.directories.output=<scratch dir>
  ```
- Before launching, the script reads back the Electron fuses (below) and fails on any mismatch. A step that stalls,
  for example behind a Keychain prompt, fails after `E2E_STEP_TIMEOUT` seconds (default 300) with a hint.

### Privacy prompts (TCC) and denial messages

The first time OpenVern reads files in Documents, Desktop or Downloads, macOS asks for permission. On the installed
app, a project on the Desktop showed: "OpenVern" would like to access files in your Desktop folder. Choosing a folder
with **New project › Browse…** doesn't prompt, because picking it counts as permission; the prompt appeared after
quitting and reopening OpenVern, when it read the saved project. The app sets a purpose string for each of these
folders (for example "OpenVern accesses Desktop when you choose projects there."); whether the prompt shows it wasn't
recorded. The home Files panel may prompt too; that wasn't measured.

If you deny access, the Files panel shows the message below, with a **Try again** button. It persists after a restart:

> macOS blocked access to this folder. Allow access in System Settings › Privacy & Security › Files & Folders.

A file read gets the same wording with "this file". A plain permission error, which is not a macOS privacy decision,
reads: "You don't have permission to read this folder. Check its permissions in Finder (File › Get Info)."

To allow access again, open **System Settings › Privacy & Security › Files & Folders** and turn on OpenVern for that
folder. In the native check, adding the project folder again through **New project › Browse…** also restored reads for
that folder.

### Electron fuses (packaged builds)

The packaged app has these Electron fuses set (`electronFuses` in `electron-builder.yml`). The same block applies to the Linux AppImage:

| Fuse | Setting | Effect |
|---|---|---|
| `RunAsNode` | off | `ELECTRON_RUN_AS_NODE` does nothing |
| `EnableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS` is ignored |
| `EnableNodeCliInspectArguments` | off | `--inspect` doesn't open a debugger port |
| `OnlyLoadAppFromAsar` | on | code loads only from `app.asar` |
| `EnableEmbeddedAsarIntegrityValidation` | on | on macOS, a modified `app.asar` refuses to launch |
| `GrantFileProtocolExtraPrivileges` | off | the `file://` protocol gets no extra privileges |

Cookie encryption stays at Electron's default. You can read the fuses back with `npx --no-install @electron/fuses read --app <app>`.
Integrity validation doesn't apply on Linux, so no tamper refusal is claimed there.

### App states

| State | What it is | Status |
|---|---|---|
| **Dev / test** | Running from source (`dev`, `dev:web`, `preview`), tests and e2e | Works on macOS. See the table below |
| **Local install** | The `dist:mac` build installed by `install-local-mac.sh` | Built, installed into `~/Applications` and checked with the release identity on macOS (launch, menus, shortcuts, Keychain) |
| **Public release** | Developer ID signed, notarized and stapled | Not available. Needs an Apple Developer Program membership and isn't planned yet |

A build from this repository is meant for the Mac that built it. A copy moved to another Mac is quarantined and not
notarized. On another Mac, use Apple's Open Anyway flow (System Settings › Privacy & Security), or the public release
once there is one. **Never** remove the quarantine attribute, disable Gatekeeper, or start OpenVern with `--no-sandbox`.

### What was run on macOS

As of 2026-11-10, on macOS 26.6 (arm64):

| Command | Result |
|---|---|
| `npm test` | Passed: 1,302 tests passed, 1 skipped |
| `npm run typecheck`, `npm run lint` | Passed |
| `npm run e2e:web` | Passed |
| `npm run e2e:electron` (the standard command, real Keychain item) | Passed: 80 + 11 + 60 + 25 checks |
| `npm run dev:web` (API checks with the fake provider) | Passed. Keychain-free |
| `npm run dist:mac` | Passed: arm64 `.dmg` and `.app`, codesign verifies |
| `npm run e2e:packaged` (validation build) | Passed: 176 checks |
| `scripts/install-local-mac.sh` and `--uninstall` | Passed, in a temporary folder and into `~/Applications` |
| `npm run dev`, `npm run dev:web` and `npm run preview` | Start on macOS. `preview` uses the Keychain item |

The Linux commands in this README are unchanged. Their checks on this branch are still pending.

## Data

| Mode | Data directory |
|---|---|
| AppImage | `~/.config/openvern` (Electron's `userData`) |
| `npm run dev:web`, `npm run dev` | `./.dev-data` |
| `npm run preview` | `./.dev-data-preview` |
| any, with `OPENVERN_DATA_DIR` | that directory (its Electron profile is `<dir>/electron-profile`) |

Electron's profile (Chromium state, `localStorage`, single-instance lock): `~/.config/openvern` for the AppImage,
`~/.config/openvern-dev` for `npm run dev`, `~/.config/openvern-preview` for `npm run preview`. A run with `OPENVERN_DATA_DIR` gets its profile (and lock) at
`<dir>/electron-profile` in every mode, so it never collides with the installed app. `--user-data-dir=<dir>`
overrides it.

On macOS the same directories live under `~/Library/Application Support/` instead of `~/.config/`. The packaged app keeps
its data in `~/Library/Application Support/openvern`. The source-mode profiles are `openvern-dev` and `openvern-preview`.
The Linux paths above are unchanged.

**Upgrading from 0.1:** the app used to be called harness and kept its data in `~/.config/harness`. On the first start
of the packaged app, when `~/.config/openvern` has no `settings.json`, `projects.json` or chats, OpenVern **copies**
`settings.json`, `secrets.json`, `projects.json`, `chats/`, `attachments/` and `cache/` over and writes a
`migrated-from-harness` marker. The old directory is left alone. If the saved OpenRouter key no longer decrypts
(the keyring entry may follow the app name), Settings asks for it again.

```
<dataDir>/
  settings.json         last chosen model
  secrets.json          the OpenRouter key (mode 0600)
  projects.json         projects (name, absolute folder path)
  chats/index.json      chat list (rebuilt from chats/ if missing or corrupt)
  chats/<chatId>.json   one file per chat: messages, tool calls and results
  attachments/<id>.bin  uploaded file bytes; <id>.json is its metadata
  cache/models.json     OpenRouter model list (refreshed hourly)
  changes/<chatId>.json pending change set, its retry snapshot, applied batches and unreported events
```

**Where the API key lives.** In the AppImage (and `npm run preview`) the key is encrypted with Electron's
`safeStorage` (KWallet on KDE) and `secrets.json` says `"enc": "safeStorage"`. If the desktop has no usable keyring,
it falls back to plaintext with mode 0600 and logs that. In `npm run dev:web` / `npm run dev` the key is plaintext
in `secrets.json` (mode 0600) by design. The renderer never receives the key after saving; it only sees whether one is
configured and a masked hint (`sk-or-v1-…a1b2`). Projects are never copied or modified: removing a project only
forgets the folder.

The browser build keeps UI state (sidebar collapsed, expanded projects) in `localStorage`; in the app it lives in
that mode's Electron profile (see above).

## Tests

| Command | What it does |
|---|---|
| `npm test` | Vitest: node tests for `shared` / `core` / `server`, jsdom tests for `renderer`. |
| `npm run typecheck` | `tsc --noEmit` for the node and web halves. |
| `npm run lint` | Biome lint and format check (`npm run format` applies fixes). |
| `npm run e2e` | End-to-end tour of the real UI against the real backend with the fake provider: the V0 tour (A1–A18, except the manual parts listed under Limitations), then the v0.2 edit/review flow (`scripts/e2e/edits.mjs`: propose, disk unchanged, panel states, Files, partial apply with byte checks, next-turn note, conflict after an outside edit, retry restore). First in web dev (headless Chromium), then in the built Electron app (`npm run build` first). Not part of `npm test`. |
| `npm run e2e:web` / `npm run e2e:electron` | One half only. |

Every change must pass `npm run typecheck && npm run lint && npm test`.

The e2e scripts (`scripts/e2e/`) use temporary data and Electron profile directories (never `~/.config/openvern`), start
and stop every process they need, and clean up on exit. Useful switches: `E2E_KEEP=1` keeps the scratch directory
(screenshots, logs, the fixtures), `E2E_OUT_DIR=<dir>` chooses it, `E2E_SECTIONS=A2,A11` runs only those sections
(A2 stores the key most others need), `E2E_SKIP_BUILD=1` reuses `out/`, and `E2E_SHOTS=1` also takes screenshots of
the main screens, the Files panel, an open file and Diff (unified, and split where it fits) at 1440×900 and 1080×720
(with an overflow check) into `<scratch>/shots` (`E2E_SKIP_SMOKE=1` for only those, `E2E_SKIP_EDITS=1` to skip the edit flow).

## Known limitations

- **OpenRouter only**, and untested against the live API in this repo's automation (it needs a key): the
  `reasoning_details` round trip for reasoning models with tools is implemented from the docs and unverified; OpenRouter's
  capability metadata (`tools`, image input) can be wrong for some models, in which case the error is shown.
- **Edits are proposals only** and no commands: nothing is written until you apply, applied edits can't be undone from
  the app, files can't be renamed or moved, binary files can't be edited, hunk decisions are not kept across a reload,
  and there is no auto mode yet (planned). Tools are sandboxed to the project root, skip ignored and secret-looking
  files (`.env`, keys), and cap file and result sizes.
- **No** editing or regenerating past messages, branching, token or cost display (usage is stored, not shown), context
  compaction, chat search, light theme, auto-update, pacman/AUR package, Windows builds, a notarized (public) macOS build, or Intel and universal macOS builds.
- **Attachments**: text files and images (PNG, JPEG, WebP, GIF) through the attach menu or the Files panel's Attach
  button: no paste, no drag and drop. Text up to 512 KB, images up to 10 MB, 10 files per message.
- `Ctrl+N` (New chat) works in the app; browsers reserve it.
- A chat whose first reply was stopped or failed keeps the title "New chat" (titles are generated after the first
  completed turn). Failed "move to project" requests only refetch; there is no toast component.
- The AppImage needs `fuse2` and user namespaces. It is x86_64 only. The minimum window size is 1080×720.
- The macOS build is arm64 only, ad-hoc signed and not notarized. See [macOS (Apple Silicon)](#macos-apple-silicon).
- Automated checks cover web dev and the built Electron app with the fake provider. Still manual: the A5 tool-row spinner and the `list_files` row (the fake provider only calls `read_file`), the A12 real offline case (the script only injects `[fake:error=network_error]`), a real key against
  OpenRouter, the native folder picker, launching from the KDE launcher after `install-local.sh`, and the AppImage on the
  Arch machine.

## Layout

```
src/shared/     contracts shared by everything: types, errors, API schemas, stream events, constants, SSE reader
src/core/       storage, provider adapters, project tools, agent loop (no Electron imports)
src/server/     Hono app (/api) and the standalone dev server
src/main/       Electron main process (prod backend, protocol handler, safeStorage)
src/preload/    Electron preload (window.openvern bridge)
src/renderer/   React UI
scripts/        install-local.sh, e2e/ (end-to-end tests and screenshots), spikes/, try-openrouter.ts
```

Path aliases: `@shared/*`, `@core/*`, `@server/*`, `@renderer/*`.
