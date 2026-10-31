# harness

A desktop AI harness: chat with LLMs about your local code projects. V0 talks to [OpenRouter](https://openrouter.ai)
only, lets the model **read** a project (list, read and search files) through tool calls, and runs both in a browser
(dev) and as a Linux AppImage. It cannot modify files or run commands.

The plan, contracts, work sections and the acceptance checklist are in [`docs/v0-plan.md`](docs/v0-plan.md).

## Prerequisites

- Linux x86_64 (developed on CachyOS / Arch, KDE Wayland)
- Node.js 22 or newer, npm 10 or newer
- `fuse2` to run the AppImage, and unprivileged user namespaces for Chromium's sandbox (enabled on Arch / CachyOS kernels)
- An [OpenRouter API key](https://openrouter.ai/keys) to chat for real. Not needed with the fake provider or the mock API (see below)
- For `npm run e2e` (web half): a Chromium, either Playwright's (`npx playwright install chromium`), one on `PATH`, or
  `E2E_CHROME=/path/to/chrome`. The Electron half needs a display

## Install

```bash
npm ci
```

Electron's binary is downloaded by a postinstall step. If `npm run dev` or `npm run preview` complain that it is
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
| `npm run preview` | Builds, then runs Electron on the **production wiring** (`app://harness/`, backend inside the main process). Data in `./.dev-data-preview`. |

Ports 8787 (API) and 5173 (Vite, strict) are fixed; stop other dev servers first.

Environment variables:

| Variable | Effect |
|---|---|
| `HARNESS_FAKE_PROVIDER=1` | The dev server (and the production wiring, so also `preview` and the AppImage) uses a scripted fake provider instead of OpenRouter: any key starting with `sk-or-` is accepted, no network, no cost. Replies read `README.md` with a `read_file` call, then answer with a code block. Test markers in a message: `[fake:slow]` (slow stream, to try Stop), `[fake:error=<code>]` (the call fails with that error code, e.g. `invalid_api_key`, `provider_error`) `[fake:flaky]` (fails once, succeeds on Retry) and `[fake:read=<path>]` (the first tool call reads that path, e.g. `.env`, to see the sandbox refuse it). |
| `HARNESS_DATA_DIR=<dir>` | Overrides the data directory in every mode. |
| `VITE_API=mock` | The renderer uses an in-memory mock API (seeded sample data, fake streaming); no server needed. E.g. `VITE_API=mock npm run dev:web`. |

Typical keyless session: `HARNESS_FAKE_PROVIDER=1 npm run dev:web`, open Settings, paste any `sk-or-…` key.

## Build and install

```bash
npm run build           # main, preload and renderer into out/ (the renderer bundle is minified)
npm run dist            # build + package release/harness-<version>-x86_64.AppImage
scripts/install-local.sh              # install the newest AppImage for your user
scripts/install-local.sh --uninstall  # remove what it installed
```

`install-local.sh` copies the AppImage to `~/.local/bin/harness.AppImage`, the icon to
`~/.local/share/icons/hicolor/512x512/apps/harness.png` and writes `~/.local/share/applications/harness.desktop`
(then refreshes the desktop database if the tool exists). It is idempotent. Run `harness.AppImage` from a terminal
to see the logs.

## Data

| Mode | Data directory |
|---|---|
| AppImage | `~/.config/harness` (Electron's `userData`) |
| `npm run dev:web`, `npm run dev` | `./.dev-data` |
| `npm run preview` | `./.dev-data-preview` |
| any, with `HARNESS_DATA_DIR` | that directory |

```
<dataDir>/
  settings.json         last chosen model
  secrets.json          the OpenRouter key (mode 0600)
  projects.json         projects (name, absolute folder path)
  chats/index.json      chat list (rebuilt from chats/ if missing or corrupt)
  chats/<chatId>.json   one file per chat: messages, tool calls and results
  attachments/<id>.bin  uploaded file bytes; <id>.json is its metadata
  cache/models.json     OpenRouter model list (refreshed hourly)
```

**Where the API key lives.** In the AppImage (and `npm run preview`) the key is encrypted with Electron's
`safeStorage` (KWallet on KDE) and `secrets.json` says `"enc": "safeStorage"`. If the desktop has no usable keyring,
it falls back to plaintext with mode 0600 and logs that. In `npm run dev:web` / `npm run dev` the key is plaintext
in `secrets.json` (mode 0600) by design. The renderer never receives the key after saving; it only sees whether one is
configured and a masked hint (`sk-or-v1-…a1b2`). Projects are never copied or modified: removing a project only
forgets the folder.

The browser build keeps UI state (sidebar collapsed, expanded projects) in `localStorage`; in the app it lives in
Electron's `userData`.

## Tests

| Command | What it does |
|---|---|
| `npm test` | Vitest: node tests for `shared` / `core` / `server`, jsdom tests for `renderer`. |
| `npm run typecheck` | `tsc --noEmit` for the node and web halves. |
| `npm run lint` | Biome lint and format check (`npm run format` applies fixes). |
| `npm run e2e` | End-to-end tour of the real UI (checklist items A1–A18 of the plan) against the real backend with the fake provider: first in web dev (headless Chromium), then in the built Electron app (`npm run build` first). Not part of `npm test`. |
| `npm run e2e:web` / `npm run e2e:electron` | One half only. |

Every change must pass `npm run typecheck && npm run lint && npm test`.

The e2e scripts (`scripts/e2e/`) use temporary data and Electron profile directories (never `~/.config/harness`), start
and stop every process they need, and clean up on exit. Useful switches: `E2E_KEEP=1` keeps the scratch directory
(screenshots, logs, the fixtures), `E2E_OUT_DIR=<dir>` chooses it, `E2E_SECTIONS=A2,A11` runs only those sections
(A2 stores the key most others need), `E2E_SKIP_BUILD=1` reuses `out/`, and `E2E_SHOTS=1` also takes screenshots of
the main screens at 1440×900, 800×600 and 720×600 (with an overflow check) into `<scratch>/shots`
(`E2E_SKIP_SMOKE=1` for only those).

## Known limitations (V0)

- **OpenRouter only**, and untested against the live API in this repo's automation (it needs a key): the
  `reasoning_details` round trip for reasoning models with tools is implemented from the docs and unverified; OpenRouter's
  capability metadata (`tools`, image input) can be wrong for some models, in which case the error is shown.
- **Read-only project access**: no file edits, no commands. Tools are sandboxed to the project root, skip ignored and
  secret-looking files (`.env`, keys), and cap file and result sizes.
- **No** editing or regenerating past messages, branching, token or cost display (usage is stored, not shown), context
  compaction, chat search, light theme, auto-update, pacman/AUR package, or Windows/macOS builds.
- **Attachments**: text files and images (PNG, JPEG, WebP, GIF) through the attach menu only: no paste, no drag and drop,
  no picking project files. Text up to 512 KB, images up to 10 MB, 10 files per message.
- `Ctrl+N` (New chat) works in the app; browsers reserve it.
- A chat whose first reply was stopped or failed keeps the title "New chat" (titles are generated after the first
  completed turn). Failed "move to project" requests only refetch; there is no toast component.
- The AppImage needs `fuse2` and user namespaces. It is x86_64 only. The minimum window size is 800×600; below 760 px
  wide the sidebar becomes an overlay.
- Automated checks cover web dev and the built Electron app with the fake provider. Still manual: a real key against
  OpenRouter, the native folder picker, launching from the KDE launcher after `install-local.sh`, and the AppImage on the
  Arch machine.

## Layout

```
src/shared/     contracts shared by everything: types, errors, API schemas, stream events, constants, SSE reader
src/core/       storage, provider adapters, project tools, agent loop (no Electron imports)
src/server/     Hono app (/api) and the standalone dev server
src/main/       Electron main process (prod backend, protocol handler, safeStorage)
src/preload/    Electron preload (window.harness bridge)
src/renderer/   React UI
scripts/        install-local.sh, e2e/ (end-to-end tests and screenshots), spikes/, try-openrouter.ts
```

Path aliases: `@shared/*`, `@core/*`, `@server/*`, `@renderer/*`.
