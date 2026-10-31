# harness

A desktop AI harness: chat with LLMs about your local code projects. V0 talks to [OpenRouter](https://openrouter.ai)
only, lets the model **read** a project (list, read, search files) through tool calls, and runs both in a browser
(dev) and as a Linux AppImage.

Status: **V0 in progress.** The plan, contracts and work sections are in [`docs/v0-plan.md`](docs/v0-plan.md).

## Prerequisites

- Linux x86_64 (developed on CachyOS / Arch, KDE Wayland)
- Node.js 22 or newer, npm 10 or newer
- `fuse2` to run the AppImage
- An OpenRouter API key, once the real provider lands (not needed with the fake provider or the mock API)

## Setup

```bash
npm install
```

If `npm run dev` says Electron failed to install (its download is a postinstall step), fetch the binary with:

```bash
node node_modules/electron/install.js
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev:server` | API server only, on `http://127.0.0.1:8787/api` (`tsx watch`, restarts on change). |
| `npm run dev:web` | API server + renderer in the browser at `http://localhost:5173` (Vite proxies `/api` to the server). |
| `npm run dev` | API server + Electron window on the same Vite dev server (DevTools available). |
| `npm run build` | Builds main, preload and renderer into `out/` with electron-vite. |
| `npm run preview` | Builds, then runs Electron on the production wiring with data in `./.dev-data-preview`. |
| `npm run dist` | Builds and packages the Linux AppImage into `release/`. |
| `npm test` | Vitest: node tests for `shared`/`core`/`server`, jsdom tests for `renderer`. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run typecheck` | `tsc --noEmit` for the node and web halves. |
| `npm run lint` | Biome lint + format check. |
| `npm run format` | Biome: apply formatting and safe fixes. |

Every change must pass `npm run typecheck && npm run lint && npm test`.

## Environment variables

| Variable | Effect |
|---|---|
| `VITE_API=mock` | The renderer uses the in-memory `MockApiClient` (seeded sample data, fake streaming); no server needed. E.g. `VITE_API=mock npm run dev:web`. |
| `HARNESS_FAKE_PROVIDER=1` | The dev server uses `FakeProvider` instead of OpenRouter (no key, no cost). |
| `HARNESS_DATA_DIR=<dir>` | Overrides the data directory in every mode (default `./.dev-data` in dev, `~/.config/harness` in the AppImage). |

## Layout

```
src/shared/     contracts shared by everything: types, errors, API schemas, stream events, constants, SSE reader
src/core/       storage, provider adapters, project tools, agent loop (no Electron imports)
src/server/     Hono app (/api) and the standalone dev server
src/main/       Electron main process
src/preload/    Electron preload (window.harness bridge)
src/renderer/   React UI
```

Path aliases: `@shared/*`, `@core/*`, `@server/*`, `@renderer/*`.
