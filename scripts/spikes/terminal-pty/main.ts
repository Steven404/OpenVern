// T0.3 spike (docs/terminal-plan.md): does node-pty load in the Electron main process and spawn the login shell in
// dev, in preview and in the packaged macOS app? A stand-in main entry: it spawns the shell, runs one `echo`, exits the
// shell and quits with 0 on success. No window. It is built with the app's real `main` config (aliases, `node-pty`
// external, everything else bundled) through ./electron.vite.config.ts, which swaps only the entry.
//
// Run from the repo root (unset ELECTRON_RUN_AS_NODE first if your host exports it):
//   dev:      npx electron-vite dev --config scripts/spikes/terminal-pty/electron.vite.config.ts
//   preview:  npx electron-vite build --config scripts/spikes/terminal-pty/electron.vite.config.ts \
//               && npx electron-vite preview --skipBuild --config scripts/spikes/terminal-pty/electron.vite.config.ts
//   packaged: npx electron-vite build --config scripts/spikes/terminal-pty/electron.vite.config.ts \
//               && npx electron-builder --mac --arm64 \
//               && release/mac-arm64/OpenVern.app/Contents/MacOS/openvern
// Each mode builds into out/, and the packaged one into release/: rebuild the real app afterwards (`npm run build`).
// The result is one `SPIKE_RESULT {json}` line on stdout. The Chromium profile goes to a temp dir that is removed on
// exit, so the real OpenVern profile is never touched.
//
// RESULT (node-pty 1.1.0, Electron 45.2.1, macOS 26.6 arm64, 2026-11-15): PASS in dev, preview and packaged.
//  - The login shell (zsh -l) ran the echo and exited 0 in all three. Packaged: JS from app.asar, pty.node and
//    spawn-helper from app.asar.unpacked. The fuses (asar integrity, onlyLoadAppFromAsar) still hold.
//  - node-pty's tarball ships prebuilds/darwin-*/spawn-helper as 0644, which fails with "posix_spawnp failed.".
//    The root `postinstall` in package.json makes it 0755, and electron-builder keeps that mode when packaging.
//  - Needs `npmRebuild: false` and `asar.smartUnpack: false` in electron-builder.yml (the comments there say why).
//  - Linux: no prebuilds; `npm ci` compiles it (python3, make, C++). Not yet checked in the AppImage.

import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { app } from 'electron';
import { spawn } from 'node-pty';

const TIMEOUT_MS = 15_000;
// The shell echoes the command line back, so look for the evaluated value, which only appears if the shell ran it.
const COMMAND = 'echo ok-$((40 + 2))';
const EXPECTED = 'ok-42';

const profileDir = mkdtempSync(join(tmpdir(), 'openvern-pty-spike-'));
app.setPath('userData', profileDir);
// On process exit rather than in finish(): Chromium can write to the profile while it shuts down after app.exit().
process.on('exit', () => rmSync(profileDir, { recursive: true, force: true }));

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// §2: `$SHELL` when it is an absolute path to an executable file, else the platform fallbacks.
function pickShell(): string {
  const fromEnv = process.env.SHELL;
  if (fromEnv && isAbsolute(fromEnv) && isExecutableFile(fromEnv)) return fromEnv;
  const fallbacks = process.platform === 'darwin' ? ['/bin/zsh', '/bin/bash', '/bin/sh'] : ['/bin/bash', '/bin/sh'];
  return fallbacks.find(isExecutableFile) ?? '/bin/sh';
}

// §2: drop the app's own variables and the ones that break shells; set the terminal ones.
function shellEnv(): Record<string, string> {
  const dropped = [/^OPENVERN_/, /^ELECTRON_/, /^npm_/, /^NODE_OPTIONS$/, /^NO_COLOR$/, /^FORCE_COLOR$/];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !dropped.some((re) => re.test(key))) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'OpenVern';
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  return env;
}

// Where node-pty came from, and the mode of the spawn-helper it will exec (same lookup as node-pty's lib/utils.js
// and lib/unixTerminal.js: build/Release first, then prebuilds/<platform>-<arch>, with app.asar → app.asar.unpacked).
function nodePtyFiles() {
  const entry = createRequire(import.meta.url).resolve('node-pty');
  const root = dirname(dirname(entry));
  const dirs = ['build/Release', `prebuilds/${process.platform}-${process.arch}`];
  const native = dirs
    .map((d) => join(root, d).replace('app.asar', 'app.asar.unpacked'))
    .find((d) => existsSync(join(d, 'pty.node')));
  let spawnHelper: { path: string; mode: string; executable: boolean } | null = null;
  if (native && process.platform === 'darwin') {
    const path = join(native, 'spawn-helper');
    spawnHelper = { path, mode: (statSync(path).mode & 0o777).toString(8), executable: isExecutableFile(path) };
  }
  return { entry, native, spawnHelper };
}

function stripAnsi(text: string): string {
  // CSI, OSC (BEL- or ST-terminated) and the remaining two-byte escapes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '');
}

function finish(result: Record<string, unknown>, ok: boolean): void {
  console.log(`SPIKE_RESULT ${JSON.stringify({ ok, ...result })}`);
  app.exit(ok ? 0 : 1);
}

void app.whenReady().then(() => {
  const started = Date.now();
  // electron-vite passes NODE_ENV_ELECTRON_VITE to the app: 'development' for `dev`, 'production' for `preview`.
  const mode = app.isPackaged ? 'packaged' : process.env.NODE_ENV_ELECTRON_VITE === 'development' ? 'dev' : 'preview';
  const base = {
    mode,
    electron: process.versions.electron,
    platform: `${process.platform}-${process.arch}`,
    appPath: app.getAppPath(),
  };
  let files: ReturnType<typeof nodePtyFiles> | null = null;
  try {
    files = nodePtyFiles();
    const shell = pickShell();
    const cwd = homedir();
    const pty = spawn(shell, ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: shellEnv() });
    let output = '';
    let sentExit = false;
    const timer = setTimeout(() => {
      pty.kill();
      finish(
        { ...base, files, shell, error: `timed out after ${TIMEOUT_MS} ms`, tail: stripAnsi(output).slice(-400) },
        false,
      );
    }, TIMEOUT_MS);
    pty.onData((data) => {
      output += data;
      if (
        !sentExit &&
        stripAnsi(output)
          .split(/\r?\n/)
          .some((line) => line.trim() === EXPECTED)
      ) {
        sentExit = true;
        pty.write('exit\r');
      }
    });
    pty.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      const sawOutput = stripAnsi(output)
        .split(/\r?\n/)
        .some((line) => line.trim() === EXPECTED);
      finish(
        {
          ...base,
          files,
          shell: basename(shell),
          cwd,
          pid: pty.pid,
          exitCode,
          signal,
          sawOutput,
          ms: Date.now() - started,
        },
        sawOutput && exitCode === 0,
      );
    });
    // Give the login shell a moment to print its prompt, then run the command.
    setTimeout(() => pty.write(`${COMMAND}\r`), 300);
  } catch (err) {
    finish({ ...base, files, error: err instanceof Error ? err.message : String(err) }, false);
  }
});
