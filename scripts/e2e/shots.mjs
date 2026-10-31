// S9.3 visual pass: screenshots of the main screens at 1440x900 and 800x600 (Electron's minimum window), plus the
// narrow-window sidebar overlay, with an automatic overflow check. Run through the runners with E2E_SHOTS=1; the
// screenshots land in $E2E_OUT/shots (keep them with E2E_KEEP=1 or E2E_OUT_DIR=<dir>).
// Same env as smoke.mjs: E2E_MODE, E2E_BASE, E2E_OUT, CDP_PORT.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';

const MODE = process.env.E2E_MODE ?? 'web';
const BASE = process.env.E2E_BASE ?? 'http://localhost:5173/';
const OUT = process.env.E2E_OUT;
const PORT = process.env.CDP_PORT;
if (!OUT || !PORT) throw new Error('E2E_OUT and CDP_PORT are required');

const SHOTS = join(OUT, 'shots');
const PROJECT = join(OUT, 'fixtures', 'shots-proj');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
writeFileSync(join(PROJECT, 'README.md'), '# Demo project\n\nA tiny fixture for the screenshots.\n');

const page = await connect(PORT, { urlPrefix: MODE === 'electron' ? 'app://' : undefined });
const { ev, waitFor, click, key, type, byText, viewport } = page;

const api = (path, method = 'GET', body) =>
  ev(`fetch('/api${path}', {
    method: ${JSON.stringify(method)},
    headers: { 'X-Harness-Client': '1', 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))},
  }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }))`);

/** Elements that stick out of the viewport and are not clipped by a scroll container / overflow-hidden ancestor. */
const overflowReport = () =>
  ev(`(() => {
    const W = innerWidth, H = innerHeight;
    const out = [];
    const clipped = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const r = p.getBoundingClientRect();
          if (r.right <= W + 1 && r.bottom <= H + 1) return true;
        }
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.position === 'fixed' && el.matches('[data-radix-focus-guard]')) continue;
      if ((r.right > W + 1 || r.bottom > H + 1 || r.left < -1 || r.top < -1) && !clipped(el)) {
        out.push(el.tagName.toLowerCase() + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : '') + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.right) + 'x' + Math.round(r.bottom));
      }
    }
    const de = document.documentElement;
    return { docScroll: de.scrollWidth > W || de.scrollHeight > H, bodyScroll: document.body.scrollWidth > W || document.body.scrollHeight > H, out: out.slice(0, 12) };
  })()`);

const findings = [];
const shot = async (name, vp) => {
  await sleep(450);
  const file = `${MODE}-${vp}-${name}.png`;
  await page.screenshot(join(SHOTS, file));
  const o = await overflowReport();
  const bad = o.docScroll || o.bodyScroll || o.out.length > 0;
  findings.push({ file, ...o, bad });
  console.log(`${bad ? 'OVERFLOW' : 'ok      '} ${file}${bad ? ` ${JSON.stringify(o)}` : ''}`);
};

const closeOverlays = async () => {
  for (let i = 0; i < 3; i++) {
    if (await ev(`!!document.querySelector('[role=dialog], [role=menu], [cmdk-item]')`)) {
      await key('Escape');
      await sleep(250);
    }
  }
};

// ----------------------------------------------------------------------------------------------- setup
await page.viewport(1440, 900);
await page.send('Page.navigate', { url: `${BASE}#/new` });
await waitFor(`document.body.innerText.includes('What are we building')`, 'app loaded');
await sleep(500);

if (!(await api('/settings')).body.openRouter.configured) {
  const r = await api('/settings/openrouter-key', 'PUT', { apiKey: 'sk-or-v1-0123456789abcdefa1b2' });
  if (r.status !== 200) throw new Error(`could not set the fake key: ${r.status}`);
}
let project = (await api('/projects')).body.find((p) => p.rootPath.endsWith('shots-proj'));
if (!project) project = (await api('/projects', 'POST', { rootPath: PROJECT })).body;
await ev(`location.hash = '#/new?project=${project.id}'; location.reload()`);
await sleep(1500);
await waitFor(`document.querySelector('button[aria-label^="Model:"]')`, 'model picker');

// A project chat with a tool turn, created through the UI.
await type('textarea', 'What does this project do? Look at the code.');
await key('Enter');
await waitFor(`location.hash.startsWith('#/chat/')`, 'chat');
await waitFor(
  `document.body.innerText.includes('Add a step limit early') && !document.querySelector('button[aria-label="Stop"]')`,
  'turn done',
  20000,
);
await sleep(1500);
const chatHash = await ev('location.hash');

// ----------------------------------------------------------------------------------------------- the passes
for (const [w, h] of [
  [1440, 900],
  [800, 600],
]) {
  const vp = `${w}x${h}`;
  await viewport(w, h);
  await page.send('Page.navigate', { url: `${BASE}#/new?project=${project.id}` });
  await waitFor(`document.body.innerText.includes('What are we building')`, 'new chat');
  await shot('new-chat', vp);

  await ev(`location.hash = ${JSON.stringify(chatHash)}`);
  await waitFor(`document.body.innerText.includes('Add a step limit early')`, 'chat');
  await shot('chat-tool-turn', vp);
  await click(byText('button[aria-expanded]', 'read_file'), 'tool row');
  await shot('chat-tool-expanded', vp);
  await click(byText('button[aria-expanded]', 'read_file'), 'tool row');

  await click(`document.querySelector('button[aria-label^="Model:"]')`, 'model picker');
  await waitFor(`document.querySelectorAll('[cmdk-item]').length > 0`, 'model list');
  await shot('model-picker', vp);
  await closeOverlays();

  await click(byText('aside button', 'Settings'), 'Settings');
  await waitFor(`!!document.querySelector('[role=dialog]')`, 'settings');
  await shot('settings', vp);
  await closeOverlays();

  await click(`document.querySelector('aside button[aria-label="New project"]')`, 'New project');
  await waitFor(`!!document.querySelector('[role=dialog] input')`, 'new project dialog');
  await shot('dialog-new-project', vp);
  await closeOverlays();

  await click(`document.querySelector('button[aria-label="Chat options"]')`, 'Chat options');
  await waitFor(`!!document.querySelector('[role=menu]')`, 'chat menu');
  await shot('chat-options-menu', vp);
  await closeOverlays();
}

// Narrow window (<= 760 px): the sidebar is an overlay.
await viewport(720, 600);
await page.send('Page.navigate', { url: `${BASE}${chatHash}` });
await waitFor(`document.body.innerText.includes('Add a step limit early')`, 'chat (narrow)');
await shot('narrow-closed', '720x600');
await click(`document.querySelector('button[aria-label="Open sidebar"]')`, 'Open sidebar');
await waitFor(`!!document.querySelector('aside')`, 'overlay open');
await shot('narrow-sidebar-overlay', '720x600');

const bad = findings.filter((f) => f.bad);
console.log(`\nscreenshots: ${SHOTS}\n${findings.length} taken, ${bad.length} with overflow`);
const problems = page.problems;
console.log(problems.length ? `console problems:\n${problems.join('\n')}` : 'no console problems');
page.close();
process.exit(bad.length || problems.length ? 1 : 0);
