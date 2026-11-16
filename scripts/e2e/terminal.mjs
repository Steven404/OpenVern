// T4 terminal end-to-end: the real dock, the real preload bridge, the real PTY in main and the real `read_terminal`
// relay, with the fake provider (terminal plan §6 T4.2/T4.3 and the §8 acceptance checklist).
//
//   1 the launcher's Terminal row opens the dock; `echo hello-term-$((40+2))` prints hello-term-42
//   2 `pwd` is the chat's project folder
//   3 `[fake:terminal]` makes the model call read_terminal; the tool result has hello-term-42 and no approval appears
//   4 a made-up `sk-or-v1-…` key printed in the terminal reaches the model as `«redacted:…`, never its body
//   5 a window reload brings the dock back with its output, and a new command still works
//   6 hide + Ctrl+backtick shows the same shell and the same output
//   7 another chat and back: the first chat's terminal still has its output
//   8 End kills the shell (checked with `ps` on the pid `echo $$` reported), and a later read says "No terminal is open"
//  10 on the New Chat screen, with the project chosen, the launcher opens a shell in the project folder; after
//     `echo pre-chat-$((40+1))`, sending `[fake:terminal]` moves that same shell (same pid, same output) into the new
//     chat and the model's read has pre-chat-41 (output from before the chat existed). Its no-project form (Documents)
//     is not run here: it would start a shell in the real home's Documents folder.
//   9 quitting the app leaves no shell of this test behind
//
// Real UI: everything the user would do — the launcher row, clicks, typing into the focused xterm, the mouse wheel
// through the scrollback, Ctrl+backtick, the sidebar, Hide and End. Where it is not:
//   - the terminal's text is read from xterm's rendered rows (`[data-testid=terminal-screen] .xterm-rows`), because
//     xterm keeps its buffer inside its instance and the app exposes no read on the bridge (plan §4.1). The dock is
//     short (101x11 here), so output that has scrolled out is read by wheeling up first, exactly as a user would;
//   - the fake key is assembled at runtime from three parts, so no key-shaped literal sits in this file;
//   - the chat, project and fake key are set up through the app's own HTTP API, as archive.mjs and smoke.mjs do;
//   - the final quit is a SIGTERM to the Electron process the runner started (`E2E_APP_PID`): `window.openvern` has
//     no quit call, Electron's `Browser.close` CDP command is unimplemented (it times out), and closing the window
//     only ends the shells on macOS (the app keeps running), so there is no renderer-reachable "Quit" to click.
//
// Electron only: the web build has no bridge and no dock, so this script refuses to pretend it ran there.
// Env (set by run-electron.sh / run-packaged.sh): E2E_MODE, E2E_BASE, E2E_OUT, CDP_PORT, E2E_APP_PID. Run through
// those runners.

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';

const MODE = process.env.E2E_MODE ?? 'electron';
const BASE = process.env.E2E_BASE ?? 'app://openvern/';
const OUT = process.env.E2E_OUT;
const PORT = process.env.CDP_PORT;
const APP_PID = Number(process.env.E2E_APP_PID ?? '0');
if (!OUT || !PORT) throw new Error('E2E_OUT and CDP_PORT are required');

if (MODE !== 'electron') {
  // The web suite must not run this: there is no bridge, no dock and no PTY there (plan §1.2). Say so and pass.
  console.log(`SKIP terminal: Electron only (E2E_MODE=${MODE})`);
  process.exit(0);
}

// The backend stores and reports the project root with symlinks resolved (/var → /private/var on macOS), and so does
// `pwd` in the shell. Use the real path everywhere, so the API lookup and the expectation match what main reports.
const PROJECT = join(OUT, 'fixtures', 'terminal-proj');
mkdirSync(PROJECT, { recursive: true });
const PROJECT_ROOT = realpathSync(PROJECT);
writeFileSync(join(PROJECT_ROOT, 'README.md'), '# Terminal fixture\n\nA project for the terminal e2e run.\n');

// The OpenRouter key pattern is `sk-or-v1-[0-9a-f]{8,}` (src/shared/redact.ts). Built from parts so this file never
// holds a key-shaped literal (gitleaks scans source text, not what the shell prints).
const FAKE_KEY = ['sk-or', 'v1', '0123456789abcdef0123456789abcdef'].join('-');
const KEY_BODY = '0123456789abcdef0123456789abcdef';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const note = (line) => console.log(`NOTE ${line}`);

const page = await connect(PORT, { urlPrefix: 'app://' });
const { ev, waitFor, click, key, type, byText } = page;
const shot = (name) => page.screenshot(join(OUT, `terminal-${name}.png`)).catch(() => {});

const api = (path, method = 'GET', body) =>
  ev(`fetch('/api${path}', {
    method: ${JSON.stringify(method)},
    headers: { 'X-OpenVern-Client': '1', 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))},
  }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }))`);

const FINAL_ANSWER = 'Add a step limit early';
const isIdle = `!document.querySelector('button[aria-label="Stop"]')`;
const chatId = () => ev(`location.hash.split('/').pop()`);
const hashIs = (id) => `location.hash === ${JSON.stringify(`#/chat/${id}`)}`;

const reload = async () => {
  await page.send('Page.reload');
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#root')?.children.length`, 'reload');
  await sleep(400);
};
const gotoHash = async (hash) => {
  await ev(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(250);
};

/** The composer's textarea, never xterm's hidden helper textarea. */
const COMPOSER = 'main textarea:not(.xterm-helper-textarea)';

async function send(message) {
  await type(COMPOSER, message);
  await key('Enter');
}

/** Picks a project in the new-chat chip, or "No project" (the chip shows the choice in its label). */
async function chooseProject(name) {
  const label = name ?? 'No project';
  const chipLabel = `document.querySelector('button[aria-label^="Project:"]').getAttribute('aria-label')`;
  if ((await ev(`${chipLabel}`)) === `Project: ${label}`) return;
  await click(`document.querySelector('button[aria-label^="Project:"]')`, 'project chip');
  await waitFor(`!!document.querySelector('[role=menuitemradio]')`, 'project menu');
  await click(byText('[role=menuitemradio]', label, true), `project ${label}`);
  await waitFor(`${chipLabel} === ${JSON.stringify(`Project: ${label}`)}`, `project ${label} chosen`);
}

/** Starts a chat in `projectName` (null: no project), sends one message and waits for the fake reply to finish. */
async function startChat(projectName, message) {
  await gotoHash('#/new');
  await waitFor(`document.body.innerText.includes('What are we building')`, 'new chat hero');
  await chooseProject(projectName);
  await send(message);
  await waitFor(`location.hash.startsWith('#/chat/')`, 'chat opened');
  await waitFor(`${isIdle} && document.body.innerText.includes(${JSON.stringify(FINAL_ANSWER)})`, 'fake reply', 30000);
  await sleep(400);
  return chatId();
}

/** The sidebar's project row: a button whose text is "<name><count>". */
const projectBtn = (name) =>
  `[...document.querySelectorAll('aside button[aria-expanded]')].find((b) => {
    const t = b.textContent.trim();
    return t.startsWith(${JSON.stringify(name)}) && /^\\d+$/.test(t.slice(${JSON.stringify(name)}.length));
  })`;

/** Opens the right panel and the launcher, then clicks the Terminal row (plan §5 "Launcher row"). */
async function openDockFromLauncher(stepLabel = '1') {
  const pressed = await ev(
    `document.querySelector('button[aria-label="Toggle right panel"]')?.getAttribute('aria-pressed')`,
  );
  if (pressed !== 'true') await click(`document.querySelector('button[aria-label="Toggle right panel"]')`, 'panel');
  await waitFor(`!!document.querySelector('#right-panel')`, 'right panel');
  await click(`document.querySelector('button[aria-label="Open a panel"]')`, 'Open a panel');
  await waitFor(`!!document.querySelector('button[aria-keyshortcuts="T"]')`, 'launcher');
  const enabled = await ev(`!document.querySelector('button[aria-keyshortcuts="T"]').disabled`);
  check(`${stepLabel} the launcher Terminal row is enabled in Electron`, enabled === true);
  await click(byText('button[aria-keyshortcuts="T"]', 'Terminal'), 'Terminal row');
  await waitFor(`!!document.querySelector('[data-terminal-dock]')`, 'terminal dock');
  await waitFor(`!!document.querySelector('[data-testid="terminal-screen"] .xterm-rows')`, 'xterm screen');
}

// ---------------------------------------------------------------------------------- reading the real terminal
//
// xterm's buffer is private to its instance, and the bridge has no `read` (plan §4.1). The DOM renderer keeps one
// `.xterm-rows > div` per visible row, so the rendered text is what a user sees.

const TERM_TEXT = `(() => {
  const screen = document.querySelector('[data-testid="terminal-screen"]');
  if (!screen) return null;
  const rows = [...screen.querySelectorAll('.xterm-rows > div')];
  return rows.map((r) => (r.textContent || '').replace(/\\u00a0/g, ' ')).join('\\n');
})()`;
const termText = () => ev(TERM_TEXT);

/**
 * Waits until the terminal's rendered text stops changing. A login shell prints its startup files (this machine's
 * oh-my-zsh asks an update question on first start), and typing while that is still running can lose a character.
 */
async function waitForTerminalQuiet(quietMs = 700, timeoutMs = 15000) {
  const t0 = Date.now();
  let last = null;
  let since = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const text = (await termText()) ?? '';
    if (text !== last) {
      last = text;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
    await sleep(100);
  }
}

async function waitForTermText(needle, ms = 10000, joined = false) {
  const t0 = Date.now();
  let text = null;
  while (Date.now() - t0 < ms) {
    text = await termText();
    const hay = joined && text !== null ? text.replace(/\n/g, '') : text;
    if (hay?.includes(needle)) return text;
    await sleep(120);
  }
  return null;
}

/**
 * The rendered text plus what wheeling up reveals. The dock is 11 rows high, so a marker printed several commands ago
 * has scrolled into xterm's scrollback; a user reads it by scrolling, which is what this does (no buffer access).
 */
async function readTerminalScrollback() {
  const box = await ev(`(() => {
    const e = document.querySelector('[data-testid="terminal-screen"]');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) return '';
  const pages = [];
  for (let i = 0; i < 14; i++) {
    pages.push((await termText()) ?? '');
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: box.x,
      y: box.y,
      deltaX: 0,
      deltaY: -400,
    });
    await sleep(90);
  }
  pages.push((await termText()) ?? '');
  return pages.join('\n');
}

/** Clicks the terminal so xterm's textarea owns the keyboard (a dock opened by the launcher already focuses it). */
async function focusTerminal() {
  await click(`document.querySelector('[data-testid="terminal-screen"]')`, 'terminal screen');
  await waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`, 'terminal focus', 5000);
}

/**
 * Types a command the way a keyboard does and presses Enter. `Input.insertText` is the browser's own insertText path,
 * which xterm handles in `_inputEvent`; Enter is a real key event, which xterm maps to CR.
 */
async function typeInTerminal(text) {
  await page.send('Input.insertText', { text });
  const enter = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r', unmodifiedText: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
}

/**
 * Runs a command and waits for its output. Retried (up to 3 times) because the first keystroke can be eaten by the
 * shell's startup: a startup prompt (oh-my-zsh's update question) reads it before the shell reads the line.
 */
async function runInTerminal(command, needle, label, joined = false) {
  await focusTerminal();
  await waitForTerminalQuiet();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await focusTerminal();
    await typeInTerminal(command);
    const text = await waitForTermText(needle, 6000, joined);
    if (text !== null) return text;
    note(`"${command}" printed no ${label} (attempt ${attempt} of 3)`);
    await waitForTerminalQuiet(600, 8000);
  }
  throw new Error(`the terminal never showed ${label}\n--- terminal ---\n${(await termText()) ?? ''}`);
}

/** `Ctrl`+backtick, the dock shortcut (plan §5 "Focus"); works while xterm has focus (capture listener). */
async function pressCtrlBacktick() {
  const base = { key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192, modifiers: 2 };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Runs `echo <tag>-$$` and reads the pid the shell reports, using our own marker (never a prompt shape). */
async function readShellPid(tag) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await focusTerminal();
    await typeInTerminal(`echo ${tag}-$$`);
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const match = new RegExp(`${tag}-(\\d+)`).exec((await termText()) ?? '');
      if (match) return Number(match[1]);
      await sleep(120);
    }
    note(`the shell printed no ${tag}-<pid> (attempt ${attempt} of 3)`);
    await waitForTerminalQuiet(600, 8000);
  }
  throw new Error(`the shell never printed ${tag}-<pid>`);
}

// ---------------------------------------------------------------------------------- reading `read_terminal` rows

const readRows = `[...document.querySelectorAll('[data-testid="tool-row"]')].filter((r) => r.innerText.includes('read_terminal'))`;
const readCount = () => ev(`${readRows}.length`);

/** The n-th (1-based) read_terminal row, in the state the fake turn left it: ok for a read, failed for no terminal. */
async function waitForReadRow(n, state) {
  await waitFor(
    `${readRows}.length === ${n} && ${readRows}.at(-1).getAttribute('data-state') === ${JSON.stringify(state)}`,
    `read_terminal row ${n} (${state})`,
    30000,
  );
}

/** Expands the last read_terminal row and returns its Output section (the second `pre`). */
async function readRowOutput(n) {
  await click(`${readRows}.at(-1).querySelector('button')`, `read_terminal row ${n}`);
  await waitFor(`!!${readRows}.at(-1)?.querySelectorAll('pre')[1]`, 'tool output', 5000);
  return ev(`${readRows}.at(-1).querySelectorAll('pre')[1].textContent`);
}

/** True while `pid` is a live process. Read-only: nothing here signals anything. */
const alive = (pid) => {
  try {
    execFileSync('ps', ['-p', String(pid), '-o', 'pid='], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

async function waitForDead(pid, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!alive(pid)) return true;
    await sleep(150);
  }
  return false;
}

async function step(label, fn) {
  try {
    await fn();
  } catch (err) {
    check(`${label} threw`, false, String(err.message).split('\n')[0]);
    await shot(`${label.split(' ')[0]}-error`);
  }
}

// ------------------------------------------------------------------------------------------------------- setup

await page.viewport(1440, 900);
await page.send('Page.navigate', { url: `${BASE}#/new` });
await waitFor(`document.body.innerText.includes('What are we building')`, 'app loaded');
await sleep(500);
if (!(await api('/settings')).body.openRouter.configured) {
  const r = await api('/settings/openrouter-key', 'PUT', { apiKey: 'sk-or-v1-0123456789abcdefa1b2' });
  if (r.status !== 200) throw new Error(`could not set the fake key: ${r.status}`);
}
let project = (await api('/projects')).body.find((p) => p.rootPath === PROJECT_ROOT);
if (!project) {
  const added = await api('/projects', 'POST', { rootPath: PROJECT_ROOT });
  if (added.status !== 200 && added.status !== 201) throw new Error(`could not add the project: ${added.status}`);
  project = added.body;
}
const NAME = project.name;
await reload();
await waitFor(`!!${projectBtn(NAME)}`, 'project row');

let chatA = null;
let shellPid = null;
const readState = { rows: 0 };

try {
  chatA = await startChat(NAME, 'Terminal e2e: open a shell');
  check(
    'setup the first chat is a project chat',
    chatA !== null && (await api(`/chats/${chatA}`)).body.projectId === project.id,
  );
  readState.rows = await readCount();

  // ------------------------------------------------------------------ 1 the launcher opens a working shell
  await step('1 dock', async () => {
    await openDockFromLauncher();
    check('1 the Terminal row opened the dock', await ev(`!!document.querySelector('[data-terminal-dock]')`));
    const header = await ev(`document.querySelector('[data-terminal-dock] header')?.innerText ?? ''`);
    check(
      '1 the dock header shows the shell and folder',
      /·/.test(header) && header.includes(PROJECT_ROOT),
      header.trim(),
    );
    const echoText = await runInTerminal('echo hello-term-$((40+2))', 'hello-term-42', 'hello-term-42');
    check('1 the terminal printed hello-term-42', echoText.includes('hello-term-42'));
    shellPid = await readShellPid('OVPID1');
    check('1 the shell reported its pid', Number.isInteger(shellPid), `pid=${shellPid}`);
  });

  // ------------------------------------------------------------------ 2 the shell starts in the project folder
  await step('2 cwd', async () => {
    // The path is longer than the dock is wide (101 columns), so xterm wraps the output over two rows; compare with
    // the row breaks taken out. The echo of the command has no expanded path, so the wait can't pass on it.
    const text = await runInTerminal('echo OVPWD:$(pwd)', `OVPWD:${PROJECT_ROOT}`, 'the project folder', true);
    const joined = text.replace(/\n/g, '');
    check(
      '2 the shell is in the project folder (pwd)',
      joined.includes(`OVPWD:${PROJECT_ROOT}`),
      `expected OVPWD:${PROJECT_ROOT}`,
    );
  });

  // ------------------------------------------------------------------ 3 the model reads the terminal
  let step3Output = '';
  let step3Assistant = '';
  await step('3 read', async () => {
    await send('[fake:terminal] what does my terminal show?');
    await waitFor(`${isIdle}`, 'fake terminal turn', 30000);
    readState.rows += 1;
    await waitForReadRow(readState.rows, 'ok');
    check('3 a read_terminal tool row appeared', true);
    step3Assistant = await ev(
      `[...document.querySelectorAll('[data-testid="assistant-turn"]')].at(-1)?.innerText ?? ''`,
    );
    check(
      '3 the model repeated the result’s first line',
      step3Assistant.includes('Terminal:') && step3Assistant.includes('running'),
      step3Assistant.split('\n').find((l) => l.startsWith('Terminal:')) ?? '',
    );
    step3Output = await readRowOutput(readState.rows);
    check('3 the tool result contains hello-term-42', step3Output.includes('hello-term-42'));
    const dialog = await ev(
      `!!document.querySelector('[role="dialog"], [role="alertdialog"]') || /\\bApprove\\b/i.test(document.body.innerText)`,
    );
    check('3 no approval prompt appeared', dialog === false);
  });

  // ------------------------------------------------------------------ 4 secrets are redacted before the model sees them
  let step4Output = '';
  await step('4 redaction', async () => {
    await runInTerminal(`echo ${FAKE_KEY}`, KEY_BODY, 'the printed key body');
    await send('[fake:terminal] read it again');
    await waitFor(`${isIdle}`, 'second fake terminal turn', 30000);
    readState.rows += 1;
    await waitForReadRow(readState.rows, 'ok');
    step4Output = await readRowOutput(readState.rows);
    check('4 the tool result has a «redacted: placeholder', step4Output.includes('«redacted:'));
    check('4 the tool result does not contain the key body', !step4Output.includes(KEY_BODY));
    await shot('redacted');
  });

  // ------------------------------------------------------------------ 5 a reload keeps the shell and its output
  await step('5 reload', async () => {
    await reload();
    await waitFor(`!!document.querySelector('[data-terminal-dock]')`, 'dock after reload');
    await waitForTerminalQuiet();
    const text = await readTerminalScrollback();
    check(
      '5 the dock came back with the earlier output',
      text.includes('hello-term-42'),
      text.includes('hello-term-42') ? '' : 'hello-term-42 is nowhere in the scrollback',
    );
    const pidAfterReload = await readShellPid('OVPID5');
    check('5 the shell survived the reload (same pid)', pidAfterReload === shellPid, `${shellPid} → ${pidAfterReload}`);
    const echoText = await runInTerminal('echo after-reload-42', 'after-reload-42', 'a command after reload');
    check('5 a new command works after the reload', echoText.includes('after-reload-42'));
    // The emulator was rebuilt from main's replay; a read now must attach it on demand and see the new output.
    await send('[fake:terminal] read the terminal after the reload');
    await waitFor(`${isIdle}`, 'fake terminal turn after reload', 30000);
    readState.rows += 1;
    await waitForReadRow(readState.rows, 'ok');
    const afterReloadOutput = await readRowOutput(readState.rows);
    check(
      '5 a read after the reload answers from the replayed terminal',
      afterReloadOutput.includes('after-reload-42'),
    );
    await shot('reload');
  });

  // ------------------------------------------------------------------ 6 hide and show with Ctrl+backtick
  await step('6 toggle', async () => {
    await focusTerminal();
    await pressCtrlBacktick();
    await waitFor(`!document.querySelector('[data-terminal-dock]')`, 'dock hidden', 5000);
    check('6 Ctrl+backtick hides the dock', true);
    await pressCtrlBacktick();
    await waitFor(`!!document.querySelector('[data-terminal-dock]')`, 'dock shown again', 5000);
    await waitFor(
      `document.activeElement?.classList.contains('xterm-helper-textarea')`,
      'focus back in the shell',
      5000,
    );
    await waitForTerminalQuiet();
    const text = await readTerminalScrollback();
    check('6 Ctrl+backtick shows the same output again', text.includes('hello-term-42'));
    const pidAfterToggle = await readShellPid('OVPID6');
    check('6 it is the same shell', pidAfterToggle === shellPid, `${shellPid} → ${pidAfterToggle}`);
  });

  // ------------------------------------------------------------------ 7 another chat and back
  await step('7 chats', async () => {
    const chatB = await startChat(null, 'Terminal e2e: a second chat');
    check('7 the second chat is a chat without a project', (await api(`/chats/${chatB}`)).body.projectId === null);
    check('7 the second chat has no dock of its own', !(await ev(`!!document.querySelector('[data-terminal-dock]')`)));
    // Back to the first chat through the sidebar, the way the user does.
    const expanded = await ev(`(${projectBtn(NAME)})?.getAttribute('aria-expanded') === 'true'`);
    if (!expanded) {
      await click(`(${projectBtn(NAME)})`, `project ${NAME}`);
      await waitFor(`(${projectBtn(NAME)})?.getAttribute('aria-expanded') === 'true'`, 'project expanded');
    }
    const link = `aside a[href="#/chat/${chatA}"]`;
    await waitFor(`!!document.querySelector(${JSON.stringify(link)})`, 'first chat in the sidebar');
    await click(`document.querySelector(${JSON.stringify(link)})`, 'first chat link');
    await waitFor(hashIs(chatA), 'back in the first chat');
    await waitFor(`!!document.querySelector('[data-terminal-dock]')`, 'dock back on the first chat', 10000);
    await waitForTerminalQuiet();
    const text = await readTerminalScrollback();
    check('7 the first chat’s terminal still has its output', text.includes('hello-term-42'));
    const pidAfterSwitch = await readShellPid('OVPID7');
    check('7 it is still the same shell', pidAfterSwitch === shellPid, `${shellPid} → ${pidAfterSwitch}`);
  });

  // ------------------------------------------------------------------ 8 End kills the shell
  await step('8 end', async () => {
    await click(`document.querySelector('[aria-label="End terminal"]')`, 'End terminal');
    await waitFor(`!document.querySelector('[data-terminal-dock]')`, 'dock closed by End', 5000);
    const gone = await waitForDead(shellPid, 10000);
    check('8 the shell process is gone (`ps` finds no pid)', gone, `pid=${shellPid}`);
    await send('[fake:terminal] is a terminal still open?');
    await waitFor(`${isIdle}`, 'third fake terminal turn', 30000);
    readState.rows += 1;
    await waitForReadRow(readState.rows, 'failed');
    const output = await readRowOutput(readState.rows);
    check(
      '8 the tool answers that no terminal is open',
      /No terminal is open in this chat/.test(output),
      output.slice(0, 120),
    );
    const assistant = await ev(
      `[...document.querySelectorAll('[data-testid="assistant-turn"]')].at(-1)?.innerText ?? ''`,
    );
    check('8 the model tells the user no terminal is open', assistant.includes('No terminal is open in this chat'));
    await shot('ended');
  });

  // ------------------------------------------------------------------ 10 a terminal opened before the chat exists
  await step('10 pre-chat', async () => {
    await gotoHash('#/new');
    await waitFor(`document.body.innerText.includes('What are we building')`, 'new chat hero');
    await chooseProject(NAME);
    await openDockFromLauncher('10');
    const header = await ev(`document.querySelector('[data-terminal-dock] header')?.innerText ?? ''`);
    check('10 the New Chat dock starts in the project folder', header.includes(PROJECT_ROOT), header.trim());
    const echoText = await runInTerminal('echo pre-chat-$((40+1))', 'pre-chat-41', 'pre-chat-41');
    check('10 the New Chat terminal printed pre-chat-41', echoText.includes('pre-chat-41'));
    const prePid = await readShellPid('OVPIDP');
    check('10 the New Chat shell reported its pid', Number.isInteger(prePid), `pid=${prePid}`);

    await send('[fake:terminal] what did I run before this chat?');
    await waitFor(`location.hash.startsWith('#/chat/') && !(${hashIs(chatA)})`, 'the new chat opened');
    await waitFor(`${isIdle}`, 'fake terminal turn in the new chat', 30000);
    await waitForReadRow(1, 'ok');
    const output = await readRowOutput(1);
    check('10 the first read in the new chat has the pre-chat output', output.includes('pre-chat-41'));

    await waitFor(`!!document.querySelector('[data-terminal-dock]')`, 'the dock moved into the chat', 10000);
    await waitForTerminalQuiet();
    const text = await readTerminalScrollback();
    check('10 the chat’s dock shows the pre-chat output', text.includes('pre-chat-41'));
    const chatPid = await readShellPid('OVPIDQ');
    check('10 the chat has the same shell (same pid)', chatPid === prePid, `${prePid} → ${chatPid}`);
    await shot('pre-chat');

    // End it, so step 9 starts and quits a fresh shell as before.
    await click(`document.querySelector('[aria-label="End terminal"]')`, 'End terminal');
    await waitFor(`!document.querySelector('[data-terminal-dock]')`, 'dock closed by End', 5000);
    check('10 End stops the moved shell', await waitForDead(prePid, 10000), `pid=${prePid}`);
  });
} catch (err) {
  console.log(`ERROR ${err.stack}`);
  results.push(false);
  await shot('error');
}

// ------------------------------------------------------------------ 9 quitting the app leaves no shell behind
await step('9 quit', async () => {
  // A live shell at quit time, so this checks the quit path and not just step 8: open the dock again (End closed it)
  // and let the dock start a fresh shell.
  await pressCtrlBacktick();
  await waitFor(`!!document.querySelector('[data-terminal-dock]')`, 'dock reopened before quitting', 10000);
  await waitForTerminalQuiet();
  const quitPid = await readShellPid('OVPID9');
  check('9 a fresh shell is running before the quit', alive(quitPid), `pid=${quitPid}`);

  if (!APP_PID) throw new Error('E2E_APP_PID is required to quit the app (set by run-electron.sh / run-packaged.sh)');
  note(`quitting the app: SIGTERM to the Electron process ${APP_PID}`);
  try {
    process.kill(APP_PID, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }

  let down = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
    } catch {
      down = true;
      break;
    }
    await sleep(250);
  }
  check('9 the app quit (its CDP endpoint is gone)', down);
  check('9 the app process is gone (`ps` finds no pid)', !alive(APP_PID), `pid=${APP_PID}`);
  check('9 the shell running at quit time is gone', await waitForDead(quitPid, 10000), `pid=${quitPid}`);
  if (shellPid !== null) check('9 the ended shell is still gone', !alive(shellPid), `pid=${shellPid}`);
});

console.log('--- console problems');
const problems = page.problems.slice(0, 30);
console.log(problems.length ? problems.join('\n') : '(none)');
check('no console errors or page exceptions', problems.length === 0);
const failed = results.filter((r) => !r).length;
console.log(`\nterminal/${MODE}: ${results.length - failed} passed, ${failed} failed`);
page.close();
process.exit(failed ? 1 : 0);
