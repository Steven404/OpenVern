# B7 — Electron profile isolation and sandbox (S8-N3, S8-N2)

Files: new `src/main/startup.ts` + `startup.test.ts`, new `src/main/electron-builder-config.test.ts`, `src/main/index.ts`, `electron-builder.yml`, `README.md`. No `core`/`server`/`renderer` changes. Order: S8-N3, then S8-N2 (both touch the top of `index.ts`).

## Settled design
- **S8-N3: profile per mode.** Pick the profile from `isPackaged` and `isDev()` (`origin.ts:20`, `ELECTRON_RENDERER_URL`), not from `HARNESS_DATA_DIR`. That variable picks harness's data dir, not the Electron mode, and the dev server process also reads it.
  - Packaged (AppImage): `null`, so nothing changes and the profile stays `~/.config/harness`. This holds even with `HARNESS_DATA_DIR` set; see Blocked.
  - Unpackaged + dev (`npm run dev`): `<appData>/harness-dev` (the INDEX default).
  - Unpackaged without dev (`npm run preview`, or a bare `electron .`): `<appData>/harness-preview`. Dev and preview each get their own lock, so both can run next to the AppImage and next to each other. Bonus: `electron-vite preview` without `HARNESS_DATA_DIR` now falls back (`resolveDataDir`, `paths.ts:70`, via `backend.ts:22`) to `~/.config/harness-preview`, not the real data.
  - An explicit `--user-data-dir` always wins and the helper returns `null`. Chromium has already applied it by then. This keeps the e2e working: `run-electron.sh:26-27` is unpackaged and not dev, and it passes the switch *and* `HARNESS_DATA_DIR`.
- **S8-N2.** `linux.executableArgs: []` in `electron-builder.yml`. `AppImageTarget.js:24-29` reads `this.options` = `deepAssign(linux, appImage)`, so both keys work. We use `linux:`, as INDEX says. `[]` is not nullish, so `?? ["--no-sandbox"]` is skipped and Exec becomes `AppRun %U`. The AppRun `unshare -Ur true` fallback (`appImageUtil.js:207-225`) can't be configured away, so main logs a warning when `app.commandLine.hasSwitch('no-sandbox')`.

## Interfaces (`src/main/startup.ts`, pure, no `electron` import)
```ts
export interface UserDataInput { isPackaged: boolean; isDev: boolean; hasUserDataDirSwitch: boolean; appDataDir: string }
/** Profile dir to set before the single-instance lock, or null to keep Electron's default / the explicit switch. */
export function resolveUserDataDir(i: UserDataInput): string | null;
export const NO_SANDBOX_WARNING: string; // "[harness] WARNING: running with --no-sandbox; renderers are not OS-sandboxed…"
export function noSandboxWarning(hasNoSandboxSwitch: boolean): string | null;
```

## Tests first (each fails today: the module, and the yml key, don't exist)
1. `src/main/startup.test.ts` (node project), with `appDataDir = '/home/u/.config'`:
   - packaged → `null`. Packaged + switch → `null`.
   - unpackaged + dev → `path.join(appDataDir, 'harness-dev')`.
   - unpackaged + not dev → `…/harness-preview`.
   - unpackaged + switch (dev or not) → `null` (e2e case).
   - `noSandboxWarning(true)` contains `--no-sandbox`. `noSandboxWarning(false)` is `null`.
2. `src/main/electron-builder-config.test.ts`: read `path.resolve(import.meta.dirname, '../../electron-builder.yml')` as text. `js-yaml` is only a transitive dependency of electron-builder (not in `package.json`), so don't import it. Assert that the `linux:` block (the text from `^linux:$` to the next top-level key) matches `/^  executableArgs: \[\]\s*$/m`, and that the file has no `no-sandbox` anywhere. Today the key is missing, which yields `--no-sandbox` by default.

## Fix steps
1. Add `startup.ts` (above). Use `path.join(appDataDir, isDev ? 'harness-dev' : 'harness-preview')`.
2. In `index.ts`, after `registerAppScheme()` and **before** `requestSingleInstanceLock()` (l.15), and at module top level (before `ready`):
   `const profile = resolveUserDataDir({ isPackaged: app.isPackaged, isDev: isDev(), hasUserDataDirSwitch: app.commandLine.hasSwitch('user-data-dir'), appDataDir: app.getPath('appData') });`
   `if (profile) app.setPath('userData', profile);` then `const warn = noSandboxWarning(app.commandLine.hasSwitch('no-sandbox')); if (warn) console.warn(warn);`
   Also log `[harness] profile: ${app.getPath('userData')}` next to the existing data-dir log (l.32) or at startup, so the mode is visible.
3. `electron-builder.yml` under `linux:`: `executableArgs: []`, with the comment `# no --no-sandbox in the AppImage's built-in .desktop Exec (S8-N2)`.
4. README: in the Data section, after the table: "Electron's profile (Chromium state, `localStorage`, single-instance lock): `~/.config/harness` for the AppImage, `~/.config/harness-dev` for `npm run dev`, `~/.config/harness-preview` for `npm run preview`. `--user-data-dir=<dir>` overrides it." Also fix l.93-94 ("in the app it lives in Electron's `userData`"), so it doesn't suggest dev uses `~/.config/harness`.
5. `backend.ts:17` docstring: say the `userData` fallback depends on the mode.

## Risks
- **e2e isolation:** depends on `hasSwitch('user-data-dir')` seeing argv switches. It does (`app.commandLine` wraps the process command line), but confirm with `npm run e2e:electron`. A18 persistence must still pass, and nothing should appear in `~/.config/harness-preview` (check with `ls` before and after).
- **Dev state moves once:** dev and preview `localStorage` (sidebar collapsed, expanded projects) and Chromium state start empty in the new profiles. Data (`./.dev-data*`) is untouched, and so is the key (dev keeps it in `./.dev-data/secrets.json`; preview uses safeStorage, which goes through the OS keyring, not the profile). Acceptable as a one-time reset in dev. Old preview state stays in `~/.config/harness`, mixed with the release profile, which is the bug being fixed. Don't migrate it.
- `getPath('appData')` and `setPath('userData')` are valid before `ready`. `sessionData` follows `userData` when it's set this early.
- The AppRun fallback can still add `--no-sandbox` when user namespaces are off. That case is only warned about, by design (§10 check).

## Verification
`npx vitest run` (new tests green), `npm run typecheck`, `npm run lint`, `npm run build` (main bundles with the new module). Manual: `npm run dev` and `npm run preview` while the AppImage is open, all three windows coexist. `npm run e2e:electron`. Optional: `npm run dist`, then `./release/harness-*.AppImage --appimage-extract '*.desktop'` and grep `Exec=AppRun %U`.

## Blocked (product decisions; defaults above apply unless overridden)
- Packaged + `HARNESS_DATA_DIR`: default is **no split**. It's rare, it has no plaintext-key risk (safeStorage), and README says `HARNESS_DATA_DIR` only moves data. A separate packaged profile is one flag away: `--user-data-dir`. Alternative: derive `<appData>/harness-<sha1(dataDir).slice(0,8)>`.
- Naming `harness-preview` (vs sharing `harness-dev`, which would make dev and preview lock each other out).
