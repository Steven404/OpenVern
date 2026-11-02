// v0.2 end-to-end: the edit/review flow through the real UI and the real backend, with the fake provider's
// `[fake:edit=…]`, `[fake:write=…]` and `[fake:delete=…]` markers (plan §6 G7.1).
//   - propose edits, check the disk is unchanged · panel disabled states · Files filter / open / attach
//   - partial apply, check the disk bytes · next-turn note · conflict after an outside edit · retry restore
// Same env as smoke.mjs: E2E_MODE, E2E_BASE, E2E_OUT, CDP_PORT. Run through the runners (after the smoke phases).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';

const MODE = process.env.E2E_MODE ?? 'web';
const BASE = process.env.E2E_BASE ?? 'http://localhost:5173/';
const OUT = process.env.E2E_OUT;
const PORT = process.env.CDP_PORT;
if (!OUT || !PORT) throw new Error('E2E_OUT and CDP_PORT are required');
const electron = MODE === 'electron';

const PROJECT = join(OUT, 'fixtures', 'edits-proj');
mkdirSync(join(PROJECT, 'src'), { recursive: true });
const file = (name) => join(PROJECT, name);
const original = {
  'a.txt': 'alpha line\nsecond a\n',
  'b.txt': 'bravo line\nsecond b\n',
  'c.txt': 'charlie line\nsecond c\n',
  'del.txt': 'to be deleted\n',
  'src/deep.ts': 'export const deep = 1;\n',
};
for (const [name, content] of Object.entries(original)) writeFileSync(file(name), content);
writeFileSync(file('.env'), 'SECRET_TOKEN=do-not-leak\n');
const read = (name) => readFileSync(file(name), 'utf8');
const EDITED = ' // edited by the fake provider';

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const page = await connect(PORT, { urlPrefix: electron ? 'app://' : undefined });
const { ev, waitFor, click, key, type, byText } = page;
const shot = (name) => page.screenshot(join(OUT, `edits-${name}.png`));

const api = (path, method = 'GET', body) =>
  ev(`fetch('/api${path}', {
    method: ${JSON.stringify(method)},
    headers: { 'X-OpenVern-Client': '1', 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))},
  }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }))`);

const isIdle = `!document.querySelector('button[aria-label="Stop"]')`;
const chatId = () => ev(`location.hash.split('/').pop()`);
const changes = async () => (await api(`/chats/${await chatId()}/changes`)).body;
const pendingPaths = async () => ((await changes()).pending?.files ?? []).map((f) => f.path).sort();
const btnText = (sel, t) => byText(sel, t, true);

async function send(message) {
  await type('textarea', message);
  await key('Enter');
}
/** Sends a message in the open chat and waits for the turn to finish. */
async function say(message, ms = 20000) {
  const before = await ev(`document.querySelectorAll('[data-testid=user-bubble]').length`);
  await send(message);
  await waitFor(`document.querySelectorAll('[data-testid=user-bubble]').length > ${before}`, 'user bubble');
  await sleep(300);
  await waitFor(isIdle, 'turn finished', ms);
  await sleep(500);
}
async function newChatIn(projectName) {
  await ev(`location.hash = '#/new'`);
  await waitFor(`document.body.innerText.includes('What are we building')`, 'new chat hero');
  await click(`document.querySelector('button[aria-label^="Project:"]')`, 'project chip');
  await waitFor(`!!document.querySelector('[role=menuitemradio]')`, 'project menu');
  await click(btnText('[role=menuitemradio]', projectName), `project ${projectName}`);
  await waitFor(
    `document.querySelector('button[aria-label^="Project:"]').getAttribute('aria-label') === ${JSON.stringify(`Project: ${projectName}`)}`,
    'project chosen',
  );
}
const panelOpen = () => ev(`!!document.querySelector('#right-panel')`);
async function setPanel(open) {
  if ((await panelOpen()) === open) return;
  await sleep(600);
  await click(`document.querySelector('button[aria-label="Toggle right panel"]')`, 'panel toggle');
  await waitFor(open ? `!!document.querySelector('#right-panel')` : `!document.querySelector('#right-panel')`, 'panel');
  await sleep(300);
}
async function showLauncher() {
  await setPanel(true);
  if (process.env.E2E_DEBUG)
    console.log(
      'tabs',
      await ev(
        `[...document.querySelectorAll('#right-panel [role=tab]')].map((t) => t.textContent.trim() + (t.getAttribute('aria-selected') === 'true' ? '*' : '')).join(',')`,
      ),
    );
  await sleep(600);
  await click(`document.querySelector('button[aria-label="Open a panel"]')`, 'plus');
  await waitFor(`document.body.innerText.includes('Open a panel')`, 'launcher').catch(async (e) => {
    console.log(
      'DEBUG',
      await ev(
        `JSON.stringify([...document.querySelectorAll('#right-panel header button')].map((b) => [b.getAttribute('aria-label') || b.textContent.trim(), b.getAttribute('aria-pressed'), b.getAttribute('aria-selected')])) + ' ' + document.querySelector('#right-panel').innerText.slice(0, 200)`,
      ),
    );
    throw e;
  });
}
const launcherRow = (label) =>
  `[...document.querySelectorAll('#right-panel ul button')].find((b) => b.querySelector('span span')?.textContent === ${JSON.stringify(label)})`;
const rowDisabled = (label) => ev(`${launcherRow(label)}?.disabled`);
async function openDiff() {
  const tab = `[...document.querySelectorAll('#right-panel [role=tab]')].find((t) => t.textContent.trim() === 'Diff')`;
  if (await ev(`!!${tab}`)) {
    await setPanel(true);
    await sleep(600); // the panel animates its width; clicking mid-animation hits the wrong tab
    if (process.env.E2E_DEBUG)
      console.log(
        'before diff-tab click',
        await ev(
          `JSON.stringify([...document.querySelectorAll('#right-panel header button')].map((b) => [b.getAttribute('aria-label') || b.textContent.trim(), Math.round(b.getBoundingClientRect().x), Math.round(b.getBoundingClientRect().width)]))`,
        ),
      );
    await click(tab, 'Diff tab');
    if (process.env.E2E_DEBUG)
      console.log(
        'after diff-tab click',
        await ev(
          `JSON.stringify([...document.querySelectorAll('#right-panel header button')].map((b) => [b.getAttribute('aria-label') || b.textContent.trim(), Math.round(b.getBoundingClientRect().x)]))`,
        ),
      );
    await waitFor(`!!document.querySelector('section[aria-label="Review changes"]')`, 'diff surface');
    await sleep(300);
    return;
  }
  await showLauncher();
  await click(launcherRow('Diff'), 'Diff row');
  await waitFor(`!!document.querySelector('section[aria-label="Review changes"]')`, 'diff surface');
  await sleep(300);
}
const hunkBtn = (label) => `document.querySelector('[data-testid=hunk] button[aria-label="${label}"]')`;
const diffFile = (path) => byText('nav[aria-label="Changed files"] button', path);
const footerText = () => ev(`document.querySelector('section[aria-label="Review changes"] footer')?.innerText ?? ''`);
const applyBtn = `[...document.querySelectorAll('section[aria-label="Review changes"] footer button')].at(-1)`;

// ----------------------------------------------------------------------------------------------- setup
await page.viewport(1440, 900);
await page.send('Page.navigate', { url: `${BASE}#/new` });
await waitFor(`document.body.innerText.includes('What are we building')`, 'app loaded');
await sleep(500);
if (!(await api('/settings')).body.openRouter.configured) {
  const r = await api('/settings/openrouter-key', 'PUT', { apiKey: 'sk-or-v1-0123456789abcdefa1b2' });
  if (r.status !== 200) throw new Error(`could not set the fake key: ${r.status}`);
}
let project = (await api('/projects')).body.find((p) => p.rootPath.endsWith('edits-proj'));
if (!project) project = (await api('/projects', 'POST', { rootPath: PROJECT })).body;
await ev('location.reload()');
await sleep(1500);
await waitFor(`document.querySelector('button[aria-label^="Model:"]')`, 'model picker');

try {
  // ------------------------------------------------------------------------- B15 chat without a project
  {
    await ev(`location.hash = '#/new'`);
    await waitFor(`document.body.innerText.includes('What are we building')`, 'hero');
    await send('hello [fake:write=loose.txt]');
    await waitFor(`location.hash.startsWith('#/chat/')`, 'chat');
    await waitFor(`${isIdle} && document.body.innerText.includes('Add a step limit early')`, 'loose turn', 20000);
    await sleep(400);
    check('B15 loose chat has no pending edits', (await changes()).pending === null);
    await showLauncher();
    check('B4 Terminal is disabled', (await rowDisabled('Terminal')) === true);
    check('B4/B15 Files is disabled in a chat without a project', (await rowDisabled('Files')) === true);
    check('B4/B15 Diff is disabled in a chat without edits', (await rowDisabled('Diff')) === true);
    const hint = await ev(`${launcherRow('Terminal')}?.innerText ?? ''`);
    check('B4 Terminal hint says "Not available yet"', hint.includes('Not available yet'), hint.replace(/\n/g, ' | '));
    await setPanel(false);
  }

  // ------------------------------------------------------------------------- B6 propose, disk unchanged
  await newChatIn('edits-proj');
  await send(
    'Please change things [fake:edit=a.txt] [fake:edit=b.txt] [fake:edit=c.txt] [fake:write=new.txt] [fake:delete=del.txt] [fake:write=.env] [fake:write=../escape.txt]',
  );
  await waitFor(`location.hash.startsWith('#/chat/')`, 'project chat');
  await waitFor(`!!document.querySelector('[data-testid=changes-card]') && ${isIdle}`, 'Proposed edits card', 25000);
  await sleep(600);
  const text = await ev('document.body.innerText');
  check(
    'B6 tool rows show edit_file / write_file / delete_file',
    ['edit_file', 'write_file', 'delete_file'].every((t) => text.includes(t)),
  );
  check('B6 "Proposed edits" card appears', text.includes('Proposed edits'));
  const paths = await pendingPaths();
  check('B6 five files staged (a, b, c, new, del)', paths.join() === 'a.txt,b.txt,c.txt,del.txt,new.txt', paths.join());
  check(
    'B6 disk unchanged after the proposal',
    Object.entries(original).every(([n, c]) => read(n) === c) && !existsSync(file('new.txt')),
  );
  check(
    'B12 .env and ../escape.txt refused when staging',
    !paths.includes('.env') && !existsSync(file('../escape.txt')) && read('.env') === 'SECRET_TOKEN=do-not-leak\n',
  );
  check('B12 the refusals show up as tool errors', /\.env|outside/i.test(text));
  await shot('proposed');

  // ------------------------------------------------------------------------- B4 launcher, B5 Files
  await showLauncher();
  check('B4 Diff is enabled once the chat has proposed edits', (await rowDisabled('Diff')) === false);
  check('B4 Files is enabled in a project chat', (await rowDisabled('Files')) === false);
  await click(launcherRow('Files'), 'Files row');
  await waitFor(`!!document.querySelector('nav[aria-label="Project files"] button')`, 'file tree');
  const treeText = () => ev(`document.querySelector('nav[aria-label="Project files"]').innerText`);
  let tree = await treeText();
  check('B5 tree lists project files', tree.includes('a.txt') && tree.includes('src'), tree.replace(/\n/g, ' '));
  check('B5 .env is not listed', !tree.includes('.env'));
  check('B5 not yet-created new.txt is not listed (disk unchanged)', !tree.includes('new.txt'));
  await type('input[aria-label="Filter files"]', 'zzzz');
  await waitFor(`document.body.innerText.includes('No files match')`, 'no match');
  check('B5 filter with no match says "No files match"', true);
  await type('input[aria-label="Filter files"]', 'deep');
  await waitFor(`!!${byText('nav[aria-label="Project files"] button', 'deep.ts')}`, 'filtered');
  tree = await treeText();
  check('B5 filter narrows to deep.ts', tree.includes('deep.ts') && !tree.includes('b.txt'));
  await type('input[aria-label="Filter files"]', '');
  await waitFor(`!!${byText('nav[aria-label="Project files"] button', 'a.txt')}`, 'unfiltered');
  await click(byText('nav[aria-label="Project files"] button', 'a.txt'), 'a.txt');
  await waitFor(
    `!!document.querySelector('[role=tabpanel]') && document.querySelector('[role=tabpanel]').innerText.includes('alpha line')`,
    'viewer',
  );
  check(
    'B5 file opens in the viewer with line numbers',
    (await ev(`document.querySelector('[role=tabpanel]').innerText`)).includes('1\n'),
  );
  check('B5 the file has a tab', await ev(`!!document.querySelector('button[aria-label="Close a.txt"]')`));
  check(
    'B5 viewer shows the original (on-disk) content',
    !(await ev(`document.querySelector('[role=tabpanel]').innerText`)).includes('edited by'),
  );
  await click(btnText('#right-panel button', 'Attach'), 'Attach');
  await waitFor(`!!document.querySelector('[data-testid=attachment-chip]')`, 'attachment chip');
  check(
    'B5 Attach adds the file to the composer',
    (await ev(`document.querySelector('[data-testid=attachment-chip]').innerText`)).includes('a.txt'),
  );
  await click(`document.querySelector('button[aria-label^="Remove a.txt"]')`, 'remove chip');
  await shot('files-viewer');

  // ------------------------------------------------------------------------- B7 review
  await openDiff();
  check(
    'B7 review lists all five files',
    (await ev(`document.querySelectorAll('nav[aria-label="Changed files"] li').length`)) === 5,
  );
  check('B7 Apply is disabled at 0 accepted', await ev(`${applyBtn}.disabled`));
  const splitBtn = `[...document.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.trim() === 'Split')`;
  check('B13 Split is enabled at 1440 px wide', (await ev(`${splitBtn}.disabled`)) === false);
  await click(splitBtn, 'Split');
  await waitFor(`${splitBtn}.getAttribute('aria-pressed') === 'true'`, 'split on');
  await sleep(500);
  await shot('diff-split');
  await click(
    `[...document.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.trim() === 'Unified')`,
    'Unified',
  );
  await sleep(400);
  // Accept all, then take b.txt and del.txt back out.
  await click(btnText('section[aria-label="Review changes"] footer button', 'Accept all'), 'Accept all');
  await waitFor(`/Apply 5/.test(${applyBtn}.innerText)`, 'Apply 5');
  check('B7 Accept all → "Apply 5"', true, (await footerText()).replace(/\n/g, ' | '));
  for (const f of ['b.txt', 'del.txt']) {
    await click(diffFile(f), f);
    await sleep(250);
    await click(hunkBtn('Undo decision'), 'Undo');
    await click(hunkBtn('Reject this change'), 'Reject');
    await waitFor(`document.querySelector('[data-testid=hunk]').dataset.decision === 'rejected'`, `${f} rejected`);
  }
  await sleep(400);
  check(
    'B7 rejected hunk is dimmed',
    (await ev(
      `getComputedStyle(document.querySelector('[data-testid=hunk]').children[document.querySelector('[data-testid=hunk]').children.length - 1]).opacity`,
    )) < 0.6,
  );
  await waitFor(`/Apply 3/.test(${applyBtn}.innerText)`, 'Apply 3');
  const foot = await footerText();
  check(
    'B7 progress text counts accepted and rejected',
    /All 5 changes reviewed/.test(foot) && /2 rejected/.test(foot),
    foot.replace(/\n/g, ' | '),
  );
  await click(byText('section[aria-label="Review changes"] button', 'Next file'), 'Next file').catch(() => {});
  await shot('diff-unified');

  // Open the Files tab on a.txt first so we can see it refresh after apply.
  const filesTab = `[...document.querySelectorAll('#right-panel [role=tab]')].find((t) => t.textContent.trim() === 'a.txt')`;
  await sleep(600);
  await click(filesTab, 'a.txt tab');
  await waitFor(`!!document.querySelector('[role=tabpanel]')`, 'viewer again');
  const viewerBefore = await ev(`document.querySelector('[role=tabpanel]').innerText`);
  await openDiff();

  // ------------------------------------------------------------------------- B8 apply
  await click(applyBtn, 'Apply');
  await waitFor(`!!${byText('[data-testid=changes-card]', 'Edits applied')}`, 'Edits applied card');
  check('B8 card turns into "Edits applied"', true);
  const cardText = await ev(`document.querySelector('[data-testid=changes-card]').innerText`);
  check(
    'B8 card says "Wrote 3 changes to 3 files · 2 rejected"',
    /Wrote 3 changes to 3 files · 2 rejected/.test(cardText),
    cardText.replace(/\n/g, ' | '),
  );
  check(
    'B8 a.txt has exactly the accepted hunk',
    read('a.txt') === `alpha line${EDITED}\nsecond a\n`,
    JSON.stringify(read('a.txt')),
  );
  check(
    'B8 c.txt has the accepted hunk',
    read('c.txt') === `charlie line${EDITED}\nsecond c\n`,
    JSON.stringify(read('c.txt')),
  );
  check('B8 rejected b.txt is byte-identical', read('b.txt') === original['b.txt']);
  check(
    'B8 rejected delete: del.txt still exists',
    existsSync(file('del.txt')) && read('del.txt') === original['del.txt'],
  );
  check(
    'B8 accepted create: new.txt written',
    existsSync(file('new.txt')),
    existsSync(file('new.txt')) ? read('new.txt').trim() : '',
  );
  check('B7 after apply no edits are pending', (await changes()).pending === null);
  check(
    'B7 Diff surface says nothing is waiting',
    (await ev(`document.querySelector('section[aria-label="Review changes"]').innerText`)).includes(
      'No edits are waiting',
    ),
  );
  check('B8 Applied list shows the batch', await ev(`!!document.querySelector('[data-testid=applied-batch]')`));
  await shot('diff-applied');
  await sleep(600);
  await click(filesTab, 'a.txt tab');
  await waitFor(
    `document.querySelector('[role=tabpanel]')?.innerText.includes('edited by the fake provider')`,
    'viewer refreshed',
    8000,
  ).then(
    () => check('B8 Files viewer shows the new content after apply', true),
    () =>
      check(
        'B8 Files viewer shows the new content after apply',
        false,
        `before=${JSON.stringify(viewerBefore.slice(0, 60))}`,
      ),
  );
  await click(
    `[...document.querySelectorAll('#right-panel [role=tab]')].find((t) => t.textContent.trim() === 'Files')`,
    'Files tab',
  );
  await waitFor(`!!document.querySelector('nav[aria-label="Project files"]')`, 'tree');
  await sleep(500);
  check(
    'B8 file tree lists new.txt after apply',
    await ev(`!!${byText('nav[aria-label="Project files"] button', 'new.txt')}`).catch(() => false),
  );
  await showLauncher();
  check('B4 Diff stays enabled after apply (applied history)', (await rowDisabled('Diff')) === false);
  await setPanel(false);

  // ------------------------------------------------------------------------- B10 next-turn note
  await say('What did I apply and what did I reject?');
  const id1 = await chatId();
  const msgs = (await api(`/chats/${id1}`)).body.messages;
  const note = msgs.filter((m) => m.role === 'user').at(-1)?.changesNote ?? '';
  check(
    'B10 changesNote lists what was written',
    /Written:.*a\.txt/.test(note) && /c\.txt/.test(note),
    note.replace(/\n/g, ' | '),
  );
  check('B10 changesNote lists what was rejected', /Rejected:/.test(note) && /b\.txt/.test(note));
  check(
    'B10 changesNote is attached only once',
    !msgs
      .filter((m) => m.role === 'user')
      .slice(0, -1)
      .some((m) => m.changesNote === note),
  );
  await say('And again, anything pending?');
  check(
    'B10 no second note',
    !(await api(`/chats/${id1}`)).body.messages.filter((m) => m.role === 'user').at(-1)?.changesNote,
  );

  // ------------------------------------------------------------------------- B9 conflict after an outside edit
  await say('Edit again [fake:edit=b.txt] [fake:edit=c.txt]');
  check('B9 two files proposed', (await pendingPaths()).join() === 'b.txt,c.txt', (await pendingPaths()).join());
  writeFileSync(file('c.txt'), 'charlie edited outside the app\n');
  await openDiff();
  await click(btnText('section[aria-label="Review changes"] footer button', 'Accept all'), 'Accept all');
  await waitFor(`/Apply 2/.test(${applyBtn}.innerText)`, 'Apply 2');
  await click(applyBtn, 'Apply');
  await waitFor(
    `!document.querySelector('[data-testid=changes-card]') || !${byText('[data-testid=changes-card]', 'Proposed edits')}`,
    'applied',
  );
  await sleep(500);
  check('B9 b.txt applied', read('b.txt') === `bravo line${EDITED}\nsecond b\n`, JSON.stringify(read('b.txt')));
  check('B9 c.txt untouched (outside edit wins)', read('c.txt') === 'charlie edited outside the app\n');
  const batch = (await changes()).applied.at(-1);
  check(
    'B9 batch records the conflict',
    batch?.conflicts.length === 1 && batch.conflicts[0].reason === 'changed_on_disk',
    JSON.stringify(batch?.conflicts),
  );
  const panelText = await ev(`document.querySelector('#right-panel').innerText`);
  check(
    'B9 the user can see c.txt "Changed on disk" in the Applied list',
    /c\.txt[\s\S]*Changed on disk/.test(panelText),
    panelText.slice(-200).replace(/\n/g, ' | '),
  );
  await setPanel(false);
  const lastCard = await ev(`[...document.querySelectorAll('[data-testid=changes-card]')].at(-1).innerText`);
  check(
    'B9 the card itself says one file was not written (panel closed)',
    /1 not written \(changed on disk\)/.test(lastCard),
    lastCard.replace(/\n/g, ' | '),
  );
  await shot('conflict');
  await setPanel(false);
  await say('Anything skipped?');
  const note2 = (await api(`/chats/${id1}`)).body.messages.filter((m) => m.role === 'user').at(-1)?.changesNote ?? '';
  check(
    'B10 changesNote reports the changed-on-disk file',
    /changed on disk[\s\S]*c\.txt|c\.txt[\s\S]*changed on disk/i.test(note2),
    note2.replace(/\n/g, ' | '),
  );

  // ------------------------------------------------------------------------- B11 retry restores the proposal
  await say('First proposal [fake:write=r1.txt]');
  check('B11 setup: r1 pending', (await pendingPaths()).join() === 'r1.txt');
  await say('Second proposal [fake:write=r2.txt]');
  check('B11 setup: r1 and r2 pending', (await pendingPaths()).join() === 'r1.txt,r2.txt');
  const del = await api(`/chats/${id1}/changes`, 'DELETE');
  check('B11 setup: discard clears the set', del.status === 200 && (await pendingPaths()).length === 0);
  await ev(`(async () => {
    const r = await fetch('/api/chats/${id1}/retry', {
      method: 'POST',
      headers: { 'X-OpenVern-Client': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: (await (await fetch('/api/chats/${id1}', { headers: { 'X-OpenVern-Client': '1' } })).json()).model }),
    });
    const reader = r.body.getReader();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    return r.status + ' ' + out;
  })()`).then((o) => o.startsWith('200') || console.log('retry stream:', o.slice(0, 200)));
  const restored = await pendingPaths();
  check(
    'B11 retry restores the proposal to the turn start, then re-proposes (r1 + r2)',
    restored.join() === 'r1.txt,r2.txt',
    restored.join(),
  );
  check('B11 retry did not write to disk', !existsSync(file('r1.txt')) && !existsSync(file('r2.txt')));
  await ev('location.reload()');
  await waitFor(`!!${byText('[data-testid=changes-card]', 'Proposed edits')}`, 'card after reload');
  check('B11 the card is back after a reload', true);
} catch (err) {
  console.log(`ERROR ${err.stack}`);
  results.push(false);
  await shot('error').catch(() => {});
}

console.log('--- console problems');
const problems = page.problems.slice(0, 30);
console.log(problems.length ? problems.join('\n') : '(none)');
check('no console errors or page exceptions', problems.length === 0);
const failed = results.filter((r) => !r).length;
console.log(`\nedits/${MODE}: ${results.length - failed} passed, ${failed} failed`);
page.close();
process.exit(failed ? 1 : 0);
