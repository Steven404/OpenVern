// End-to-end smoke test of the real UI against the real backend with the fake provider (plan §8, S9.2).
// Not part of `npm test`; run it through `npm run e2e` (scripts/e2e/run-web.sh / run-electron.sh), which start the
// servers with temp data dirs, launch the browser / Electron and always clean up.
//
//   E2E_PHASE=main     the full tour (A1–A17); writes state.json
//   E2E_PHASE=persist  after the runner restarted the server / app with the same data dir (A18)
//
// Env: E2E_MODE=web|electron · E2E_BASE (app URL) · E2E_OUT (scratch dir: fixtures, screenshots, state.json) ·
//      CDP_PORT · E2E_DATA_DIR (the backend's data dir, for the secrets-file check)
// The fake provider understands the prompt markers `[fake:slow]`, `[fake:error=<code>]` and `[fake:flaky]`.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { connect, sleep } from './cdp.mjs';

const env = (name, fallback) =>
  process.env[name] ??
  fallback ??
  (() => {
    throw new Error(`${name} is required`);
  })();
const MODE = env('E2E_MODE', 'web');
const PHASE = env('E2E_PHASE', 'main');
const BASE = env('E2E_BASE');
const OUT = env('E2E_OUT');
const PORT = env('CDP_PORT');
const DATA_DIR = process.env.E2E_DATA_DIR;
const electron = MODE === 'electron';

// ---------------------------------------------------------------------------------------------------- fixtures

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A small valid RGB PNG (gradient), so thumbnails visibly render. */
function makePng(width = 96, height = 64) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set([242 - x, 140 + y, 143 + (x >> 1)], row + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FIXTURES = join(OUT, 'fixtures');
const PROJECT_A = join(FIXTURES, 'e2e-proj');
const PROJECT_B = join(FIXTURES, 'e2e-proj-b');
const TS_FILE = join(FIXTURES, 'sample.ts');
const PNG_FILE = join(FIXTURES, 'sample.png');
const STATE_FILE = join(OUT, 'state.json');

if (PHASE === 'main') {
  for (const dir of [PROJECT_A, PROJECT_B]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# Demo project\n\nA tiny fixture for the e2e run.\n');
  }
  writeFileSync(
    TS_FILE,
    'export const answer: number = 42;\nexport function greet(name: string) {\n  return "hi " + name;\n}\n',
  );
  writeFileSync(PNG_FILE, makePng());
}

// -------------------------------------------------------------------------------------------------- reporting

const results = [];
const check = (name, ok, extra = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`;
  results.push({ ok, line });
  console.log(line);
};
const note = (line) => console.log(`NOTE ${line}`);

// ------------------------------------------------------------------------------------------------------ driver

const page = await connect(PORT, { urlPrefix: electron ? 'app://' : undefined });
const { ev, waitFor, click, key, type, byText, text, setFiles } = page;
const shot = (name) => page.screenshot(join(OUT, `${PHASE}-${name}.png`));

const api = (path, method = 'GET', body) =>
  ev(`fetch('/api${path}', {
    method: ${JSON.stringify(method)},
    headers: { 'X-Harness-Client': '1', 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))},
  }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }))`);

const lastByText = (selector, label) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.textContent.trim() === ${JSON.stringify(label)}).at(-1)`;

const gotoHash = async (hash) => {
  await ev(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(250);
};
const reload = async () => {
  await page.send('Page.reload');
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#root')?.children.length`, 'reload');
  await sleep(400);
};

const sidebarLink = (title) => byText('aside a[href*="#/chat/"]', title);
const isIdle = `!document.querySelector('button[aria-label="Stop"]')`;
const FINAL_ANSWER = 'Add a step limit early';
const answered = `document.body.innerText.includes(${JSON.stringify(FINAL_ANSWER)})`;
const header = () => ev(`document.querySelector('main header')?.innerText ?? ''`);

async function send(message) {
  await type('textarea', message);
  await key('Enter');
}

async function newChat() {
  await click(byText('aside button', 'New chat'), 'New chat button');
  await waitFor(`location.hash.startsWith('#/new')`, 'new chat screen');
  await waitFor(`document.body.innerText.includes('What are we building')`, 'hero');
}

async function chooseProject(name) {
  await click(`document.querySelector('button[aria-label^="Project:"]')`, 'project chip');
  await waitFor(`!!document.querySelector('[role=menuitemradio]')`, 'project menu');
  await click(byText('[role=menuitemradio]', name, true), `project ${name}`);
  await waitFor(
    `document.querySelector('button[aria-label^="Project:"]').getAttribute('aria-label') === ${JSON.stringify(`Project: ${name}`)}`,
    'project chosen',
  );
}

async function pickModel(name) {
  await click(`document.querySelector('button[aria-label^="Model:"]')`, 'model picker');
  await waitFor(`document.querySelectorAll('[cmdk-item]').length > 0`, 'model list');
  await click(byText('[cmdk-item]', name), `model ${name}`);
  await waitFor(`!document.querySelector('[cmdk-item]')`, 'model popover closed');
  await waitFor(
    `document.querySelector('button[aria-label^="Model:"]')?.getAttribute('aria-label').includes(${JSON.stringify(name)})`,
    `model ${name} selected`,
  );
}

/** Opens a Radix submenu: a click usually does it; ArrowRight is the keyboard fallback. */
async function openSubmenu(label, firstItemRole, firstItemText) {
  await click(byText('[role=menuitem]', label), label);
  const open = `!!${byText(`[role=${firstItemRole}]`, firstItemText, true)}`;
  try {
    await waitFor(open, 'submenu', 1200);
  } catch {
    await key('ArrowRight');
    await waitFor(open, 'submenu (keyboard)');
  }
}

async function menuItem(triggerExpr, itemText, { role = 'menuitem' } = {}) {
  await click(triggerExpr, 'menu trigger');
  await waitFor(`!!${byText(`[role=${role}]`, itemText)}`, `menu item ${itemText}`);
  await click(byText(`[role=${role}]`, itemText), `menu item ${itemText}`);
}

const chatOptions = `document.querySelector('button[aria-label="Chat options"]')`;
const readyChips = `document.querySelectorAll('[data-testid=attachment-chip][data-status=ready]').length`;
const accept = () => ev(`document.querySelector('[data-testid=file-input]').accept`);
const imageNotice = () => ev(`document.querySelector('[data-testid=image-notice]')?.textContent ?? null`);
const imgLoaded = (scope) =>
  `(() => { const i = document.querySelector(${JSON.stringify(`${scope} img`)}); return !!i && i.complete && i.naturalWidth > 0; })()`;

const ONLY = process.env.E2E_SECTIONS?.split(',').map((s) => s.trim());

/** `E2E_SECTIONS=A2,A11` runs just those sections (A2 sets the API key most others need); handy when debugging. */
async function section(name, fn) {
  if (ONLY && !name.split('/').some((n) => ONLY.includes(n)) && !name.startsWith('A18')) return;
  console.log(`--- ${name}`);
  try {
    await fn();
  } catch (err) {
    check(`${name} (aborted)`, false, err.message.split('\n')[0]);
    console.log(err.stack);
    await shot(`error-${name.replace(/\W+/g, '-')}`).catch(() => {});
    // Leave any open dialog / menu behind so the next section starts clean.
    await key('Escape').catch(() => {});
    await gotoHash('#/new').catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------- phases

async function openApp() {
  await page.viewport(1440, 900);
  await page.send('Page.navigate', { url: `${BASE}#/new` });
  await waitFor(`document.body.innerText.includes('What are we building')`, 'new chat hero');
  await sleep(500);
}

async function mainPhase() {
  await openApp();

  await section('A1', async () => {
    await shot('a1-fresh');
    const t = await text();
    check('A1 no-key notice', t.includes('Add your OpenRouter API key to start chatting.'));
    check(
      'A1 send disabled',
      await ev(`document.querySelector('button[aria-label="Send message"]')?.disabled === true`),
    );
  });

  await section('A2', async () => {
    await click(byText('aside button', 'Settings'), 'Settings');
    await waitFor(`!!document.querySelector('[role=dialog] input[type=password]')`, 'settings dialog');
    await type('[role=dialog] input', 'bad-key');
    await click(byText('[role=dialog] button', 'Save', true), 'Save');
    await waitFor(`document.body.innerText.includes('OpenRouter rejected this key.')`, 'rejection error');
    check('A2 invalid key rejected', true);
    await type('[role=dialog] input', 'sk-or-v1-0123456789abcdefa1b2');
    await click(byText('[role=dialog] button', 'Save', true), 'Save');
    await waitFor(`document.body.innerText.includes('Connected')`, 'connected');
    check('A2 connected + masked hint', (await text()).includes('sk-or-v1-…a1b2'));
    await shot('a2-settings-connected');
    const settings = await api('/settings');
    check(
      'A2 renderer never receives the full key',
      !JSON.stringify(settings.body).includes('0123456789abcdef'),
      JSON.stringify(settings.body),
    );
    // Reopen: still masked.
    await key('Escape');
    await waitFor(`!document.querySelector('[role=dialog]')`, 'settings closed');
    await click(byText('aside button', 'Settings'), 'Settings');
    await waitFor(`document.body.innerText.includes('sk-or-v1-…a1b2')`, 'masked on reopen');
    await sleep(400); // dialog open animation
    check('A2 reopening shows it masked', true);
    // Remove, then add it back for the rest of the tour.
    await click(byText('[role=dialog] button', 'Remove key', true), 'Remove key');
    await waitFor(
      `!!${lastByText('[role=dialog] button, [role=alertdialog] button', 'Remove key')} && document.querySelectorAll('[role=dialog],[role=alertdialog]').length > 1`,
      'confirm dialog',
    );
    await click(lastByText('[role=dialog] button, [role=alertdialog] button', 'Remove key'), 'confirm remove');
    await waitFor(`!!document.querySelector('[role=dialog] input[type=password]')`, 'key form after remove');
    check('A2 Remove key works', (await api('/settings')).body.openRouter.configured === false);
    await type('[role=dialog] input', 'sk-or-v1-0123456789abcdefa1b2');
    await click(byText('[role=dialog] button', 'Save', true), 'Save');
    await waitFor(`document.body.innerText.includes('Connected')`, 'reconnected');
    await key('Escape');
    await waitFor(`!document.querySelector('[role=dialog]')`, 'settings closed');
  });

  await section('A3', async () => {
    await waitFor(`document.querySelector('button[aria-label^="Model:"]')`, 'model picker trigger');
    await click(`document.querySelector('button[aria-label^="Model:"]')`, 'model picker');
    await waitFor(`document.querySelectorAll('[cmdk-item]').length >= 6`, 'model list');
    await shot('a3-model-picker');
    const items = await ev(
      `[...document.querySelectorAll('[cmdk-item]')].map((i) => i.innerText.replace(/\\n/g, ' | '))`,
    );
    check(
      'A3 picker lists models with badges',
      items.length >= 6 && items.some((i) => i.includes('Vision')) && items.some((i) => i.includes('Tools')),
      `${items.length} models`,
    );
    await type('[cmdk-input]', 'deepseek');
    await sleep(300);
    check('A3 search filters', (await ev(`document.querySelectorAll('[cmdk-item]').length`)) === 1);
    await key('Escape');
    await waitFor(`!document.querySelector('[cmdk-item]')`, 'picker closed');
    await pickModel('Claude Haiku 5.5');
    await sleep(400);
    check('A3 choice saved as lastModel', (await api('/settings')).body.lastModel === 'anthropic/claude-haiku-5.5');
  });

  await section('A4', async () => {
    if (electron) {
      // The native folder picker cannot be driven from here: check the dialog, add the project through the API.
      await click(`document.querySelector('aside button[aria-label="New project"]')`, 'New project');
      await waitFor(`!!document.querySelector('[role=dialog]')`, 'new project dialog');
      check(
        'A4 Electron dialog offers Browse…',
        (await ev(`document.querySelector('[role=dialog]').innerText`)).includes('Browse'),
      );
      await key('Escape');
      await waitFor(`!document.querySelector('[role=dialog]')`, 'dialog closed');
      const created = await api('/projects', 'POST', { rootPath: PROJECT_A });
      check(
        'A4 project added (API; picker is manual)',
        created.status === 200 || created.status === 201,
        `status ${created.status}`,
      );
      await api('/projects', 'POST', { rootPath: PROJECT_B });
      await ev(`location.hash = '#/new?project=${created.body.id}'`);
      await reload();
    } else {
      await click(`document.querySelector('aside button[aria-label="New project"]')`, 'New project');
      await waitFor(`!!document.querySelector('[role=dialog] input')`, 'new project dialog');
      await type('[role=dialog] input', '/definitely/not/here');
      await click(byText('[role=dialog] button', 'Add project', true), 'Add');
      await waitFor(
        `/does not exist|cannot be read/.test(document.querySelector('[role=dialog]')?.innerText ?? '')`,
        'path error',
      );
      check('A4 invalid path shows an inline error', true);
      await type('[role=dialog] input', PROJECT_A);
      await sleep(200);
      await click(byText('[role=dialog] button', 'Add project', true), 'Add');
      await waitFor(`!document.querySelector('[role=dialog]')`, 'dialog closes');
      await waitFor(`location.hash.startsWith('#/new?project=')`, 'navigated with project');
      check('A4 project added → #/new?project=', true, await ev('location.hash'));
      // Duplicate.
      await click(`document.querySelector('aside button[aria-label="New project"]')`, 'New project');
      await waitFor(`!!document.querySelector('[role=dialog] input')`, 'new project dialog');
      await type('[role=dialog] input', PROJECT_A);
      await click(byText('[role=dialog] button', 'Add project', true), 'Add');
      await waitFor(`/already/i.test(document.querySelector('[role=dialog]')?.innerText ?? '')`, 'duplicate error');
      check('A4 duplicate shows an inline error', true);
      await key('Escape');
      await waitFor(`!document.querySelector('[role=dialog]')`, 'dialog closed');
      await api('/projects', 'POST', { rootPath: PROJECT_B });
      await reload();
    }
    await waitFor(`document.querySelector('aside')?.innerText.includes('e2e-proj-b')`, 'both projects in the sidebar');
    const rows = await ev(
      `[...document.querySelectorAll('aside button[aria-expanded]:not([aria-haspopup])')].map((b) => b.innerText.replace(/\\s+/g, ' '))`,
    );
    check(
      'A4 projects listed with count 0',
      rows.length === 2 && rows.every((r) => r.trim().endsWith('0')),
      rows.join(' | '),
    );
    await shot('a4-projects');
    // Back to project A, preselected through the URL.
    const projects = (await api('/projects')).body;
    const a = projects.find((p) => p.name === 'e2e-proj');
    await ev(`location.hash = '#/new?project=${a.id}'`);
    await waitFor(
      `document.querySelector('button[aria-label^="Project:"]')?.getAttribute('aria-label') === 'Project: e2e-proj'`,
      'chip shows e2e-proj',
    );
  });

  await section('A5/A6', async () => {
    await send('What does this project do? Look at the code.');
    await waitFor(`location.hash.startsWith('#/chat/')`, 'navigated to chat');
    await sleep(120);
    await shot('a5-streaming');
    await waitFor(`${answered} && ${isIdle}`, 'final answer', 20000);
    await sleep(1200);
    await shot('a5-done');
    const row = await ev(`${byText('button[aria-expanded]', 'read_file')}?.innerText ?? null`);
    check(
      'A5 tool row read_file with a duration',
      !!row && /read_file/.test(row) && /\d+(\.\d)?s/.test(row),
      JSON.stringify(row),
    );
    check(
      'A5 tool row finished with ✓ (state ok)',
      await ev(`!!document.querySelector('[data-testid=tool-row][data-state=ok] svg[aria-label=Succeeded]')`),
    );
    check(
      'A5 code block highlighted (Shiki)',
      await ev(`[...document.querySelectorAll('pre span')].some((s) => s.style.color)`),
    );
    await click(byText('button[aria-expanded]', 'read_file'), 'tool row');
    await waitFor(`document.body.innerText.includes('Demo project')`, 'tool row expands');
    check('A5 tool row expands to args + output', true);
    await shot('a5-tool-expanded');
    const h = await header();
    check('A6 auto title replaces "New chat"', !h.includes('New chat') && h.length > 0, JSON.stringify(h));
    check('A6 breadcrumb shows the project', h.toUpperCase().includes('E2E-PROJ'));
    const aside = await ev(`document.querySelector('aside').innerText.replace(/\\s+/g, ' ')`);
    check('A6 sidebar count updated', /e2e-proj 1\b/.test(aside), aside);
  });

  await section('A8', async () => {
    await newChat();
    await chooseProject('No project');
    await send('hello there');
    await waitFor(`location.hash.startsWith('#/chat/')`, 'chat');
    await waitFor(`${answered} && ${isIdle}`, 'loose answer', 20000);
    await sleep(1000);
    const aside = await ev(`document.querySelector('aside').innerText`);
    check('A8 loose chat appears under CHATS', /CHATS/.test(aside));
    check('A8 no tool calls in a loose chat', !(await text()).includes('read_file'));
    await shot('a8-loose');
  });

  await section('A9', async () => {
    await newChat();
    await chooseProject('No project');
    check(
      'A9 accept includes images for a vision model',
      (await accept()).includes('image/png') && (await accept()).includes('.ts'),
      await accept(),
    );
    await setFiles([TS_FILE, PNG_FILE]);
    await waitFor(`${readyChips} === 2`, 'two ready chips');
    const chips = await ev(
      `[...document.querySelectorAll('[data-testid=attachment-chip]')].map((c) => c.innerText.replace(/\\s+/g, ' '))`,
    );
    check(
      'A9 chips for .ts and .png',
      chips.some((c) => c.includes('sample.ts')) && chips.some((c) => c.includes('sample.png')),
      chips.join(' | '),
    );
    await waitFor(imgLoaded('[data-testid=attachment-chip]'), 'composer thumbnail loaded');
    check('A9 thumbnail renders in the composer', true);
    await shot('a9-composer');
    await send('Look at these files');
    await waitFor(`location.hash.startsWith('#/chat/')`, 'chat');
    await waitFor(`${answered} && ${isIdle}`, 'answer', 20000);
    await waitFor(imgLoaded('[data-testid=user-bubble]'), 'bubble thumbnail loaded');
    check(`A9 thumbnail renders in the sent bubble${electron ? ' (app:// image header exemption)' : ''}`, true);
    const bubble = await ev(`document.querySelector('[data-testid=user-bubble]').innerText`);
    check('A9 bubble lists the text file', bubble.includes('sample.ts'));
    const id = (await ev('location.hash')).split('/').pop();
    const chat = (await api(`/chats/${id}`)).body;
    check(
      'A9 both attachments stored on the message',
      chat.messages[0].attachments
        .map((a) => a.kind)
        .sort()
        .join() === 'image,text',
    );
    state.attachChatId = id;
    await shot('a9-bubble');
  });

  await section('A10', async () => {
    // Same chat, reply composer.
    await pickModel('DeepSeek V3.2');
    check(
      'A10 non-vision model: accept has no images',
      !(await accept()).includes('image/') && (await accept()).includes('.ts'),
      await accept(),
    );
    await pickModel('Claude Haiku 5.5');
    check('A10 vision model: accept has images', (await accept()).includes('image/png'));
    // (b) image attached, switch to non-vision → removed + red notice
    await setFiles([PNG_FILE]);
    await waitFor(`${readyChips} === 1`, 'image chip');
    await pickModel('DeepSeek V3.2');
    await waitFor(`!!document.querySelector('[data-testid=image-notice]')`, 'notice');
    check(
      'A10 switching to a non-vision model removes the image',
      (await ev(readyChips)) === 0 && !(await ev(`!!document.querySelector('[data-testid=attachment-chip]')`)),
    );
    check(
      'A10 red "This model does not support image input"',
      (await imageNotice()) === 'This model does not support image input',
    );
    check(
      'A10 notice is danger-coloured',
      await ev(`getComputedStyle(document.querySelector('[data-testid=image-notice]')).color === 'rgb(255, 143, 135)'`),
    );
    await shot('a10-notice');
    // (c) clears on the next model change
    await pickModel('Claude Haiku 5.5');
    check('A10 notice clears on model change', (await imageNotice()) === null);
    // (d) clears when a file is added
    await setFiles([PNG_FILE]);
    await waitFor(`${readyChips} === 1`, 'image chip');
    await pickModel('DeepSeek V3.2');
    await waitFor(`!!document.querySelector('[data-testid=image-notice]')`, 'notice again');
    await setFiles([TS_FILE]);
    await waitFor(`${readyChips} === 1`, 'ts chip');
    check('A10 notice clears when a file is added', (await imageNotice()) === null);
    // (e) clears on send (the .ts chip rides along on the non-vision model)
    await pickModel('Claude Haiku 5.5');
    await setFiles([PNG_FILE]);
    await waitFor(`${readyChips} === 2`, 'two chips');
    await pickModel('DeepSeek V3.2');
    await waitFor(`!!document.querySelector('[data-testid=image-notice]')`, 'notice a third time');
    await send('Only the text file should go through');
    await waitFor(`!document.querySelector('[data-testid=image-notice]')`, 'notice cleared by send');
    check('A10 notice clears on send', true);
    await waitFor(
      `${isIdle} && document.querySelectorAll('[data-testid=user-bubble]').length === 2`,
      'second turn done',
      20000,
    );
    check('A10 send on a non-vision model works', true);
  });

  await section('A11', async () => {
    await newChat();
    await chooseProject('No project');
    await send('[fake:slow] please write a long answer');
    await waitFor(`location.hash.startsWith('#/chat/')`, 'chat');
    await waitFor(
      `(document.querySelector('[data-testid=assistant-turn]')?.innerText.length ?? 0) > 60`,
      'partial text',
    );
    await click(`document.querySelector('button[aria-label="Stop"]')`, 'Stop');
    await waitFor(`!!document.querySelector('[data-testid=stopped-label]')`, 'Stopped label');
    check('A11 Stop → "Stopped" label', true);
    // The server saves the partial reply a moment after the abort; Retry appears once the run has settled.
    await waitFor(`!!${byText('article button', 'Retry', true)}`, 'Retry button after settling');
    const partial = await ev(`document.querySelector('[data-testid=assistant-turn]').innerText`);
    check('A11 partial reply kept', partial.length > 60 && !partial.includes(FINAL_ANSWER), `${partial.length} chars`);
    const id = (await ev('location.hash')).split('/').pop();
    const last = (await api(`/chats/${id}`)).body.messages.at(-1);
    check(
      'A11 saved as status "stopped"',
      last.role === 'assistant' && last.status === 'stopped',
      `${last.role}/${last.status}`,
    );
    await shot('a11-stopped');
    await click(byText('article button', 'Retry', true), 'Retry');
    await waitFor(`${answered} && ${isIdle}`, 'retry completes', 25000);
    check('A11 Retry completes the reply', !(await ev(`!!document.querySelector('[data-testid=stopped-label]')`)));
  });

  await section('A12', async () => {
    await newChat();
    await chooseProject('No project');
    await send('[fake:error=invalid_api_key] hi');
    await waitFor(`!!document.querySelector('[data-testid=error-card]')`, 'error card');
    check(
      'A12 invalid_api_key card has "Open settings" and no Retry',
      await ev(
        `(() => { const c = document.querySelector('[data-testid=error-card]'); return !!${byText('[data-testid=error-card] button', 'Open settings')} && ![...c.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Retry'); })()`,
      ),
    );
    await shot('a12-error-card');
    await click(byText('[data-testid=error-card] button', 'Open settings'), 'Open settings');
    await waitFor(`!!document.querySelector('[role=dialog]')?.innerText.includes('OpenRouter')`, 'settings dialog');
    check('A12 "Open settings" opens the Settings modal', true);
    await key('Escape');
    await waitFor(`!document.querySelector('[role=dialog]')`, 'dialog closed');

    await newChat();
    await chooseProject('No project');
    await send('[fake:flaky] hi');
    await waitFor(`!!${byText('[data-testid=error-card] button', 'Retry', true)}`, 'retryable error card');
    check('A12 retryable error card shows Retry', true);
    await click(byText('[data-testid=error-card] button', 'Retry', true), 'Retry');
    await waitFor(`${answered} && ${isIdle}`, 'retry succeeds', 20000);
    check('A12 Retry recovers', !(await ev(`!!document.querySelector('[data-testid=error-card]')`)));
  });

  await section('A13', async () => {
    // A project chat to play with.
    const projects = (await api('/projects')).body;
    const b = projects.find((p) => p.name === 'e2e-proj-b');
    const a = projects.find((p) => p.name === 'e2e-proj');
    await ev(`location.hash = '#/new?project=${a.id}'`);
    await waitFor(
      `document.querySelector('button[aria-label^="Project:"]')?.getAttribute('aria-label') === 'Project: e2e-proj'`,
      'chip',
    );
    await send('chat to manage');
    await waitFor(`location.hash.startsWith('#/chat/')`, 'chat');
    await waitFor(`${answered} && ${isIdle}`, 'answer', 20000);
    await sleep(800);

    await menuItem(chatOptions, 'Rename');
    await waitFor(`!!document.querySelector('[role=dialog] input')`, 'rename dialog');
    await type('[role=dialog] input', 'Renamed chat');
    await click(byText('[role=dialog] button', 'Save', true), 'Save');
    await waitFor(`!document.querySelector('[role=dialog]')`, 'rename dialog closed');
    await waitFor(
      `(document.querySelector('main header h1')?.innerText) === 'Renamed chat' && !!${sidebarLink('Renamed chat')}`,
      'renamed everywhere',
    );
    check('A13 rename updates header and sidebar', true);

    await click(chatOptions, 'Chat options');
    await waitFor(`!!${byText('[role=menuitem]', 'Move to project')}`, 'menu');
    await openSubmenu('Move to project', 'menuitemradio', 'e2e-proj-b');
    await shot('a13-move-menu');
    await click(byText('[role=menuitemradio]', 'e2e-proj-b', true), 'e2e-proj-b');
    await waitFor(
      `(document.querySelector('main header')?.innerText ?? '').toUpperCase().includes('E2E-PROJ-B')`,
      'moved to B',
    );
    check('A13 move to another project (header crumb)', true);
    const asideB = await ev(`document.querySelector('aside').innerText.replace(/\\s+/g, ' ')`);
    check(
      'A13 sidebar shows the chat under the new project',
      /e2e-proj-b 1\b/.test(asideB) && (await ev(`!!${sidebarLink('Renamed chat')}`)),
      asideB,
    );

    await click(chatOptions, 'Chat options');
    await waitFor(`!!${byText('[role=menuitem]', 'Move to project')}`, 'menu');
    await openSubmenu('Move to project', 'menuitemradio', 'No project');
    await click(byText('[role=menuitemradio]', 'No project', true), 'No project');
    await waitFor(
      `(document.querySelector('main header')?.innerText ?? '').toUpperCase().includes('CHATS /')`,
      'moved to Chats',
    );
    check('A13 move to "No project" (header crumb Chats /)', true);
    const asideC = await ev(`document.querySelector('aside section[aria-labelledby=sidebar-chats]')?.innerText ?? ''`);
    check('A13 sidebar lists it under Chats', asideC.includes('Renamed chat'));
    check(
      'A13 counts updated (B back to 0)',
      /e2e-proj-b 0\b/.test(await ev(`document.querySelector('aside').innerText.replace(/\\s+/g, ' ')`)),
    );
    void b;

    await menuItem(chatOptions, 'Delete');
    await waitFor(`!!${byText('[role=dialog] button, [role=alertdialog] button', 'Delete', true)}`, 'confirm');
    check('A13 delete asks for confirmation', await ev(`document.body.innerText.includes('permanently deleted')`));
    await click(lastByText('[role=dialog] button, [role=alertdialog] button', 'Delete'), 'confirm Delete');
    await waitFor(`location.hash.startsWith('#/new') && !${sidebarLink('Renamed chat')}`, 'deleted');
    check('A13 delete removes the chat and returns to New chat', true);
  });

  await section('A14', async () => {
    const opts = (name) => `document.querySelector('button[aria-label="Options for ${name}"]')`;
    await menuItem(opts('e2e-proj-b'), 'New chat here');
    await waitFor(`location.hash.startsWith('#/new?project=')`, 'new chat here');
    await waitFor(
      `document.querySelector('button[aria-label^="Project:"]')?.getAttribute('aria-label') === 'Project: e2e-proj-b'`,
      'chip shows B',
    );
    check('A14 "New chat here" preselects the project', true);
    await send('hello from B');
    await waitFor(`location.hash.startsWith('#/chat/')`, 'chat');
    await waitFor(`${answered} && ${isIdle}`, 'answer', 20000);
    await sleep(800);

    await menuItem(opts('e2e-proj-b'), 'Rename');
    await waitFor(`!!document.querySelector('[role=dialog] input')`, 'rename dialog');
    await type('[role=dialog] input', 'e2e-renamed');
    await click(byText('[role=dialog] button', 'Save', true), 'Save');
    await waitFor(
      `!document.querySelector('[role=dialog]') && document.querySelector('aside').innerText.includes('e2e-renamed')`,
      'renamed',
    );
    check('A14 project rename', !(await ev(`document.querySelector('aside').innerText.includes('e2e-proj-b')`)));

    await menuItem(opts('e2e-renamed'), 'Remove');
    await waitFor(`!!document.querySelector('[role=dialog], [role=alertdialog]')`, 'remove confirm');
    const desc = await ev(`document.querySelector('[role=dialog], [role=alertdialog]').innerText`);
    check(
      'A14 remove confirm explains chats move and files stay',
      /chat moves to Chats/.test(desc) && /Files on disk are not touched/.test(desc),
      desc.replace(/\n/g, ' | '),
    );
    await shot('a14-remove-confirm');
    await click(lastByText('[role=dialog] button, [role=alertdialog] button', 'Remove'), 'confirm Remove');
    await waitFor(`!document.querySelector('aside').innerText.includes('e2e-renamed')`, 'project removed');
    const chats = (await api('/chats')).body;
    const moved = chats.find((c) => c.title !== 'New chat' && c.projectId === null);
    check(
      'A14 remove: its chat is now a loose chat',
      !!moved &&
        (await ev(`document.querySelector('aside section[aria-labelledby=sidebar-chats]')?.innerText ?? ''`)).includes(
          moved.title,
        ),
    );
    check('A14 remove: folder on disk untouched', existsSync(join(PROJECT_B, 'README.md')));
  });

  await section('A15', async () => {
    await gotoHash('#/new');
    // Project expansion persists.
    const rowState = () =>
      ev(`${byText('aside button[aria-expanded]:not([aria-haspopup])', 'e2e-proj')}?.getAttribute('aria-expanded')`);
    const before = await rowState();
    await click(byText('aside button[aria-expanded]:not([aria-haspopup])', 'e2e-proj'), 'project row');
    const flipped = before === 'true' ? 'false' : 'true';
    await waitFor(
      `${byText('aside button[aria-expanded]:not([aria-haspopup])', 'e2e-proj')}?.getAttribute('aria-expanded') === '${flipped}'`,
      'toggled',
    );
    await reload();
    check(
      'A15 project expansion persists across reload',
      (await rowState()) === flipped,
      `${before} → ${await rowState()}`,
    );
    await click(byText('aside button[aria-expanded]:not([aria-haspopup])', 'e2e-proj'), 'project row');
    await reload();
    check('A15 project expansion persists (toggled back)', (await rowState()) === before);

    // Sidebar collapse persists.
    await click(`document.querySelector('button[aria-label="Collapse sidebar"]')`, 'Collapse sidebar');
    await waitFor(
      `!document.querySelector('aside') && !!document.querySelector('button[aria-label="Open sidebar"]')`,
      'collapsed',
    );
    await shot('a15-collapsed');
    await reload();
    check(
      'A15 sidebar collapse persists across reload',
      await ev(`!document.querySelector('aside') && !!document.querySelector('button[aria-label="Open sidebar"]')`),
    );
    await click(`document.querySelector('button[aria-label="Open sidebar"]')`, 'Open sidebar');
    await waitFor(`!!document.querySelector('aside')`, 'expanded');
    await reload();
    check('A15 sidebar expanded state persists', await ev(`!!document.querySelector('aside')`));

    // Ctrl+N from a chat.
    await click(`document.querySelector('aside a[href*="#/chat/"]')`, 'a chat');
    await waitFor(`location.hash.startsWith('#/chat/')`, 'chat open');
    await ev(`document.activeElement?.blur()`);
    await key('n', 2);
    await waitFor(`location.hash.startsWith('#/new')`, 'Ctrl+N → new chat', 3000).then(
      () => check(`A15 Ctrl+N opens New chat${electron ? '' : ' (browsers may reserve it for real keypresses)'}`, true),
      () => check('A15 Ctrl+N opens New chat', false, 'hash did not change'),
    );
  });

  await section('A16', async () => {
    await gotoHash('#/new');
    await waitFor(`!!document.querySelector('textarea')`, 'composer');
    // Shift+Enter inserts a newline, Enter sends.
    await type('textarea', 'line one');
    await key('Enter', 8);
    await sleep(100);
    await ev(
      `document.activeElement.value += 'line two'; document.activeElement.dispatchEvent(new Event('input', { bubbles: true }))`,
    );
    const value = await ev(`document.querySelector('textarea').value`);
    check(
      'A16 Shift+Enter inserts a newline instead of sending',
      value.includes('\n') && (await ev('location.hash')).startsWith('#/new'),
      JSON.stringify(value),
    );
    // Keyboard reach + focus ring.
    await ev(`document.querySelector('textarea').value = ''; document.activeElement?.blur(); window.scrollTo(0, 0)`);
    const seen = [];
    for (let i = 0; i < 24; i++) {
      await key('Tab');
      seen.push(
        await ev(`(() => {
          const e = document.activeElement;
          const cs = getComputedStyle(e);
          return { tag: e.tagName.toLowerCase(), label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 24),
                   ring: e.matches(':focus-visible') && cs.outlineStyle === 'solid' && cs.outlineWidth === '2px' && cs.outlineColor === 'rgb(242, 204, 143)' };
        })()`),
      );
    }
    const distinct = new Set(seen.map((s) => `${s.tag}:${s.label}`));
    const missing = seen.filter((s) => !s.ring && s.tag !== 'textarea' && s.tag !== 'body');
    check('A16 Tab reaches many controls', distinct.size >= 8, [...distinct].join(' → '));
    check(
      'A16 every focused control (except the textarea) shows the accent focus ring',
      missing.length === 0,
      missing.map((m) => m.label).join(', '),
    );
    const labels = [...distinct].join(' ');
    check(
      'A16 Tab reaches the composer controls',
      ['Attach file', 'Model:', 'textarea'].every((l) => labels.includes(l)),
      labels,
    );
    await shot('a16-focus');
    // Enter sends (covered by every other section too).
    await ev(`document.activeElement?.blur()`);
  });

  await section('A17', async () => {
    await newChat();
    await chooseProject('No project');
    await send('[fake:slow] keep going while I wander off');
    await waitFor(`location.hash.startsWith('#/chat/')`, 'chat');
    const chatHash = await ev('location.hash');
    await waitFor(`(document.querySelector('[data-testid=assistant-turn]')?.innerText.length ?? 0) > 40`, 'streaming');
    await newChat();
    const away = Date.now();
    await sleep(1200);
    await ev(`location.hash = ${JSON.stringify(chatHash)}`);
    await waitFor(`!!document.querySelector('[data-testid=assistant-turn]')`, 'turn visible after returning');
    const progress = await ev(`document.querySelector('[data-testid=assistant-turn]').innerText.length`);
    check(
      'A17 returning shows the stream still running',
      progress > 40 && !(await ev(isIdle)),
      `${progress} chars after ${Date.now() - away} ms away`,
    );
    await waitFor(`${answered} && ${isIdle}`, 'run completes', 25000);
    const id = chatHash.split('/').pop();
    const last = (await api(`/chats/${id}`)).body.messages.at(-1);
    check(
      'A17 the run kept going and completed',
      last.role === 'assistant' && last.status === 'complete',
      `${last.role}/${last.status}`,
    );
  });

  await section('storage', async () => {
    if (!DATA_DIR) return note('E2E_DATA_DIR not set; skipping the secrets-file check');
    const file = join(DATA_DIR, 'secrets.json');
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    check('secrets.json is mode 600', (statSync(file).mode & 0o777) === 0o600);
    if (electron) {
      check(
        'secrets.json uses enc: safeStorage in Electron',
        parsed.openrouter?.enc === 'safeStorage',
        `enc=${parsed.openrouter?.enc}`,
      );
      check('secrets.json does not contain the key in clear text', !raw.includes('0123456789abcdef'));
    } else {
      note(`dev secrets file enc=${parsed.openrouter?.enc} (plaintext, mode 600, is by design in dev)`);
    }
  });

  // Snapshot for the persistence phase.
  const settings = (await api('/settings')).body;
  const models = (await api('/models')).body;
  state.lastModel = settings.lastModel;
  state.lastModelName = models.find((m) => m.id === settings.lastModel)?.name.replace(/^[^:]+:\s*/, '');
  state.keyHint = settings.openRouter.keyHint;
  state.projects = (await api('/projects')).body.map((p) => p.name).sort();
  state.chats = (await api('/chats')).body
    .map((c) => ({ id: c.id, title: c.title, projectId: c.projectId, model: c.model }))
    .sort((x, y) => x.id.localeCompare(y.id));
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  note(`state: ${state.projects.length} project(s), ${state.chats.length} chat(s), model ${state.lastModel}`);
}

async function persistPhase() {
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  await openApp();
  await section('A18', async () => {
    await waitFor(`!!document.querySelector('button[aria-label^="Model:"]')`, 'model picker');
    check('A18 key still configured', (await ev(`document.body.innerText`)).includes('Add API key') === false);
    const settings = (await api('/settings')).body;
    check(
      'A18 key hint persisted',
      settings.openRouter.configured && settings.openRouter.keyHint === saved.keyHint,
      settings.openRouter.keyHint,
    );
    check(
      'A18 model persisted (picker on New chat)',
      (await ev(`document.querySelector('button[aria-label^="Model:"]').getAttribute('aria-label')`)).includes(
        saved.lastModelName,
      ),
      saved.lastModelName,
    );
    const projects = (await api('/projects')).body.map((p) => p.name).sort();
    check('A18 projects persisted', JSON.stringify(projects) === JSON.stringify(saved.projects), projects.join(', '));
    const chats = (await api('/chats')).body
      .map((c) => ({ id: c.id, title: c.title, projectId: c.projectId, model: c.model }))
      .sort((x, y) => x.id.localeCompare(y.id));
    check(
      'A18 chats persisted (ids, titles, projects, models)',
      JSON.stringify(chats) === JSON.stringify(saved.chats),
      `${chats.length} chats`,
    );
    await ev(`location.hash = '#/chat/${saved.attachChatId}'`);
    await waitFor(
      `document.querySelectorAll('[data-testid=user-bubble]').length === 2 && ${imgLoaded('[data-testid=user-bubble]')}`,
      'messages and attachment thumbnail after restart',
    );
    const bubble = await ev(`document.querySelector('[data-testid=user-bubble]').innerText`);
    check('A18 messages persisted', await ev(`${answered}`));
    check('A18 attachments persisted (text chip + image bytes)', bubble.includes('sample.ts'));
    await shot('a18-restored');
    const titleLink = saved.chats.find((c) => c.projectId === null);
    check(
      'A18 sidebar lists chats after restart',
      (!!titleLink && (await ev(`!!${sidebarLink(titleLink.title)}`))) ||
        (await ev(`document.querySelectorAll('aside a[href*="#/chat/"]').length`)) > 0,
    );
  });
  await section('A15-restart', async () => {
    // localStorage lives in the browser profile / Electron userData, so UI state survives a restart too.
    check('A15 sidebar visible after restart (was expanded)', await ev(`!!document.querySelector('aside')`));
  });
}

const state = PHASE === 'persist' ? {} : { attachChatId: null };
let exitCode = 0;
try {
  if (PHASE === 'main') await mainPhase();
  else if (PHASE === 'persist') await persistPhase();
  else throw new Error(`unknown E2E_PHASE ${PHASE}`);
} catch (err) {
  console.log(`ERROR ${err.stack}`);
  exitCode = 1;
}

console.log('--- console problems');
const problems = page.problems.slice(0, 30);
console.log(problems.length ? problems.join('\n') : '(none)');
check('no console errors or page exceptions', problems.length === 0);
const failed = results.filter((r) => !r.ok);
console.log(`\n${PHASE}/${MODE}: ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) exitCode = 1;
page.close();
process.exit(exitCode);
