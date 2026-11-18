// Auto mode end to end: the edit mode chip, the no-Git warning, files written without approval, Undo, Retry undoing the
// previous attempt, an undo that leaves a file the user changed, Review after Auto, and the History after a reload.
// Real UI and backend, the fake provider's `[fake:edit=…]`, `[fake:write=…]` and `[fake:delete=…]` markers, and a
// fixture project outside Git. Disk state is read with `fs` and compared byte for byte.
//   1  Turn Auto on: the no-Git dialog appears; confirm.
//   2  One turn that edits, creates and deletes: the disk has the changes, the "Edits applied · Auto" card lists them.
//   3  Undo → confirm: the three files are byte-identical to the originals.
//   4  Another Auto turn, then Retry: the file has exactly one marker (the first attempt was undone).
//   5  Edit a file on disk, then Undo that turn: it is skipped and named in the card; the user's edit is kept.
//   6  Switch to Review and send an edit: a Proposed edits card, the disk unchanged.
//   7  Reload: the chat is still Review; a new chat in the project shows Review; the History lists the auto batches
//      with their undo results.
// Same env as smoke.mjs: E2E_MODE, E2E_BASE, E2E_OUT, CDP_PORT. Run through the runners (after edits.mjs).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';

const MODE = process.env.E2E_MODE ?? 'web';
const BASE = process.env.E2E_BASE ?? 'http://localhost:5173/';
const OUT = process.env.E2E_OUT;
const PORT = process.env.CDP_PORT;
if (!OUT || !PORT) throw new Error('E2E_OUT and CDP_PORT are required');
const electron = MODE === 'electron';

// The scratch dir is a fresh temp dir outside the repo. The checks below prove the fixture is not in a Git work tree.
const PROJECT = join(OUT, 'fixtures', 'auto-proj');
const PROJECT_NAME = 'auto-proj';
mkdirSync(PROJECT, { recursive: true });
const file = (name) => join(PROJECT, name);
const original = {
  'a.txt': 'alpha line\nsecond a\n',
  'b.txt': 'bravo line\nsecond b\n',
  'del.txt': 'to be deleted\n',
};
for (const [name, content] of Object.entries(original)) writeFileSync(file(name), content);
const read = (name) => readFileSync(file(name), 'utf8');
const bytes = (name) => readFileSync(file(name));
const MARKER = ' // edited by the fake provider';
const countOf = (text, part) => text.split(part).length - 1;
const originalBytes = Object.fromEntries(Object.keys(original).map((n) => [n, bytes(n)]));
const sameBytes = (name) => existsSync(file(name)) && bytes(name).equals(originalBytes[name]);

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const page = await connect(PORT, { urlPrefix: electron ? 'app://' : undefined });
const { ev, waitFor, click, key, type, byText } = page;
const shot = (name) => page.screenshot(join(OUT, `auto-${name}.png`));

const api = (path, method = 'GET', body) =>
  ev(`fetch('/api${path}', {
    method: ${JSON.stringify(method)},
    headers: { 'X-OpenVern-Client': '1', 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))},
  }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }))`);

const isIdle = `!document.querySelector('button[aria-label="Stop"]')`;
// The conversation is busy from the moment a message is sent until its run has settled (the caches are refreshed).
const settled = `!document.querySelector('section[aria-label="Conversation"][aria-busy="true"]')`;
// No finite CSS transition or animation is running (the panel animates its width; spinners loop and don't count).
const still = `document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity)`;
/** Polls a Node-side condition (e.g. server state) like `waitFor` polls the page. */
async function waitUntil(fn, label, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100); // poll interval, not a wait for readiness
  }
}
/** Reloads the page and waits until the new document is up (the old one may still match any selector). */
async function reload() {
  await ev('window.__e2eBeforeReload = true; location.reload()');
  // An evaluation can fail while the old document is torn down: that is "not yet", not an error.
  await waitUntil(
    () => ev(`!window.__e2eBeforeReload && document.readyState === 'complete'`).catch(() => false),
    'page reloaded',
    20000,
  );
}
const chatId = () => ev(`location.hash.split('/').pop()`);
const changes = async () => (await api(`/chats/${await chatId()}/changes`)).body;
const chatNow = async () => (await api(`/chats/${await chatId()}`)).body;
const autoBatches = async () => (await changes()).applied.filter((b) => b.source === 'auto');
const pendingPaths = async () => ((await changes()).pending?.files ?? []).map((f) => f.path).sort();
const btnText = (sel, t) => byText(sel, t, true);

const CHIP = `document.querySelector('[data-testid=edit-mode-chip]')`;
const chipMode = () => ev(`${CHIP}?.getAttribute('data-mode') ?? null`);
const CARDS = `[...document.querySelectorAll('[data-testid=auto-edits-card]')]`;
const lastCard = `${CARDS}.at(-1)`;
const cardCount = () => ev(`${CARDS}.length`);
const lastCardAttr = (name) => ev(`${lastCard}?.getAttribute(${JSON.stringify(name)}) ?? null`);
const lastCardText = () => ev(`${lastCard}?.innerText ?? ''`);

async function send(message) {
  await type('textarea', message);
  await key('Enter');
}
/** Sends a message in the open chat and waits for the turn to finish. */
async function say(message, ms = 25000) {
  const before = await ev(`document.querySelectorAll('[data-testid=user-bubble]').length`);
  await send(message);
  // The bubble comes from the run, so once it shows the conversation is busy until the run has settled.
  await waitFor(`document.querySelectorAll('[data-testid=user-bubble]').length > ${before}`, 'user bubble');
  await waitFor(settled, 'turn settled', ms);
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
  // The chip appears once the model is known to use tools and the project has loaded.
  await waitFor(CHIP, 'edit mode chip');
}
const dialog = `document.querySelector('[data-testid=no-git-dialog]')`;
const noMenu = `!document.querySelector('[role=menu]')`;
const chipReady = `!!${CHIP} && !${CHIP}.disabled && !${CHIP}.hasAttribute('aria-busy')`;
/**
 * Opens the chip's menu and picks a mode (a real click: Radix menus ignore a bare `.click()`). Returns once the menu
 * has closed and either the chip shows the mode (its change saved) or the no-Git dialog asks first.
 */
async function pickMode(mode) {
  await waitFor(`${noMenu} && ${chipReady} && ${still}`, 'edit mode chip ready');
  await click(CHIP, 'edit mode chip');
  await waitFor(`!!document.querySelector('[data-testid=edit-mode-${mode}]')`, 'edit mode menu');
  await click(`document.querySelector('[data-testid=edit-mode-${mode}]')`, `mode ${mode}`);
  await waitFor(
    `${noMenu} && (!!${dialog} || (${chipReady} && ${CHIP}.getAttribute('data-mode') === ${JSON.stringify(mode)}))`,
    `mode ${mode} chosen`,
  );
}

const panelOpen = () => ev(`!!document.querySelector('#right-panel')`);
async function setPanel(open) {
  if ((await panelOpen()) === open) return;
  await waitFor(`${noMenu} && ${still}`, 'page still');
  await click(`document.querySelector('button[aria-label="Toggle right panel"]')`, 'panel toggle');
  await waitFor(open ? `!!document.querySelector('#right-panel')` : `!document.querySelector('#right-panel')`, 'panel');
  await waitFor(still, 'panel animation done');
}
const launcherRow = (label) =>
  `[...document.querySelectorAll('#right-panel ul button')].find((b) => b.querySelector('span span')?.textContent === ${JSON.stringify(label)})`;
async function openDiff() {
  const tab = `[...document.querySelectorAll('#right-panel [role=tab]')].find((t) => t.textContent.trim() === 'Diff')`;
  await setPanel(true);
  // The panel animates its width; clicking mid-animation hits the wrong tab.
  await waitFor(still, 'panel animation done');
  if (await ev(`!!${tab}`)) await click(tab, 'Diff tab');
  else {
    await click(`document.querySelector('button[aria-label="Open a panel"]')`, 'plus');
    await waitFor(`document.body.innerText.includes('Open a panel')`, 'launcher');
    await click(launcherRow('Diff'), 'Diff row');
  }
  await waitFor(`!!document.querySelector('section[aria-label="Review changes"]') && ${still}`, 'diff surface');
}
const history = `document.querySelector('section[aria-label="History"]')`;
const historyEntries = `[...(${history}?.querySelectorAll('[data-testid=applied-batch]') ?? [])]`;

/** Undo on the newest Auto card: open the dialog, check what it lists, confirm. Returns the dialog text. */
async function undoLastCard() {
  await click(`${lastCard}.querySelector('[data-testid=undo-button]')`, 'Undo');
  await waitFor(`!!document.querySelector('[data-testid=undo-dialog]')`, 'undo dialog');
  const text = await ev(`document.querySelector('[data-testid=undo-dialog]').innerText`);
  await click(`document.querySelector('[data-testid=undo-confirm]')`, 'Undo edits');
  await waitFor(`!document.querySelector('[data-testid=undo-dialog]')`, 'dialog closed', 15000);
  await waitFor(
    `${lastCard}?.getAttribute('data-undo') === 'undone' && !!${lastCard}.querySelector('[data-testid=undo-status]')`,
    'card undone',
    15000,
  );
  return text;
}

// ----------------------------------------------------------------------------------------------- setup
await page.viewport(1440, 900);
await page.send('Page.navigate', { url: `${BASE}#/new` });
await waitFor(`document.body.innerText.includes('What are we building')`, 'app loaded');
if (!(await api('/settings')).body.openRouter.configured) {
  const r = await api('/settings/openrouter-key', 'PUT', { apiKey: 'sk-or-v1-0123456789abcdefa1b2' });
  if (r.status !== 200) throw new Error(`could not set the fake key: ${r.status}`);
}
let project = (await api('/projects')).body.find((p) => p.rootPath.endsWith(PROJECT_NAME));
if (!project) project = (await api('/projects', 'POST', { rootPath: PROJECT })).body;
await reload();
await waitFor(`document.querySelector('button[aria-label^="Model:"]')`, 'model picker');

try {
  // The fixture must be outside Git, or the whole run would test the wrong flow.
  {
    const git = spawnSync('git', ['-C', PROJECT, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
    const outsideGit = git.error !== undefined || git.status !== 0;
    check('setup: the fixture folder is not inside a Git work tree', outsideGit, (git.stdout ?? '').trim());
    const listed = (await api('/projects')).body.find((p) => p.id === project.id);
    check('setup: the server reports the project as inGitRepo: false', listed?.inGitRepo === false);
    if (!outsideGit || listed?.inGitRepo !== false) throw new Error('the fixture project is inside a Git repository');
  }

  // ------------------------------------------------------------------------- 1 Turn Auto on, the no-Git dialog
  await newChatIn(PROJECT_NAME);
  check('1 a new chat starts in Review', (await chipMode()) === 'review');
  await pickMode('auto');
  await waitFor(`!!${dialog}`, 'no-Git dialog');
  check('1 choosing Auto for a project outside Git opens the no-Git dialog', true);
  const dialogText = await ev(`${dialog}.innerText`);
  check(
    '1 the dialog names the project and offers both choices',
    dialogText.includes(PROJECT_NAME) &&
      dialogText.includes('Keep Review') &&
      dialogText.includes('Turn on Auto') &&
      dialogText.includes("isn't a Git repository"),
    dialogText.replace(/\n/g, ' | ').slice(0, 160),
  );
  check('1 the chip is still Review while the dialog is open', (await chipMode()) === 'review');
  await shot('no-git-dialog');
  // Keep Review changes nothing, and the dialog comes back on the next try.
  await click(`document.querySelector('[data-testid=no-git-keep-review]')`, 'Keep Review');
  await waitFor(`!${dialog}`, 'dialog closed');
  check('1 "Keep Review" closes the dialog and leaves the chip at Review', (await chipMode()) === 'review');
  await pickMode('auto');
  await waitFor(`!!${dialog}`, 'no-Git dialog again');
  check('1 the dialog shows again after "Keep Review"', true);
  await click(`document.querySelector('[data-testid=no-git-turn-on-auto]')`, 'Turn on Auto');
  await waitFor(`!${dialog} && ${CHIP}?.getAttribute('data-mode') === 'auto'`, 'Auto on');
  check('1 "Turn on Auto" closes the dialog and the chip reads Auto', (await chipMode()) === 'auto');

  // ------------------------------------------------------------------------- 2 one Auto turn writes three files
  await send('Change things [fake:edit=a.txt] [fake:write=n.txt] [fake:delete=del.txt]');
  await waitFor(`location.hash.startsWith('#/chat/')`, 'project chat');
  await waitFor(`${CARDS}.length === 1 && ${isIdle}`, 'Edits applied · Auto card', 30000);
  await waitFor(settled, 'first turn settled', 15000);
  await waitUntil(async () => (await autoBatches()).length === 1, 'first auto batch stored');
  check('2 the chat was created in Auto', (await chatNow()).editMode === 'auto' && (await chipMode()) === 'auto');
  check(
    '2 a.txt has the marker exactly once',
    read('a.txt') === `alpha line${MARKER}\nsecond a\n`,
    JSON.stringify(read('a.txt')),
  );
  check('2 n.txt exists', existsSync(file('n.txt')), existsSync(file('n.txt')) ? JSON.stringify(read('n.txt')) : '');
  check('2 del.txt is gone', !existsSync(file('del.txt')));
  check('2 b.txt was not touched', sameBytes('b.txt'));
  check('2 nothing is waiting for review', (await changes()).pending === null);
  check('2 the card is "Edits applied · Auto"', (await lastCardAttr('aria-label')) === 'Edits applied · Auto');
  const card1 = await lastCardText();
  check('2 the card lists 3 files', /3 files/.test(card1), card1.replace(/\n/g, ' | '));
  check(
    '2 the card names a.txt, n.txt and del.txt',
    ['a.txt', 'n.txt', 'del.txt'].every((n) => card1.includes(n)),
  );
  check('2 the card offers Undo', (await lastCardAttr('data-undo')) === 'undoable');
  check(
    '2 there is no Proposed edits card in Auto',
    await ev(`!${byText('[data-testid=changes-card]', 'Proposed edits')}`),
  );
  const batch1 = (await autoBatches())[0];
  check(
    '2 the server has one undoable auto batch of three files',
    (await autoBatches()).length === 1 && batch1?.undoable === true && batch1.written.length === 3,
  );
  check('2 the card carries the batch id', (await lastCardAttr('data-batch-id')) === batch1?.id);
  await shot('auto-card');

  // ------------------------------------------------------------------------- 3 Undo restores the originals
  const undoText = await undoLastCard();
  check(
    '3 the undo dialog lists the three files',
    ['a.txt', 'n.txt', 'del.txt'].every((n) => undoText.includes(n)),
    undoText.replace(/\n/g, ' | ').slice(0, 200),
  );
  check('3 a.txt is byte-identical to the original', sameBytes('a.txt'));
  check('3 del.txt is back and byte-identical', sameBytes('del.txt'));
  check('3 n.txt is gone again', !existsSync(file('n.txt')));
  check('3 b.txt is still byte-identical', sameBytes('b.txt'));
  check(
    '3 the card shows "Undone · 3 files restored" and no Undo button',
    (await lastCardText()).includes('Undone · 3 files restored') &&
      !(await ev(`!!${lastCard}.querySelector('[data-testid=undo-button]')`)),
    (await lastCardText()).replace(/\n/g, ' | '),
  );
  check(
    '3 the status says undone by the user',
    (await ev(`${lastCard}.querySelector('[data-testid=undo-status]')?.getAttribute('data-by')`)) === 'user',
  );
  const afterUndo = (await autoBatches())[0];
  check(
    '3 the server records the undo by the user with the three paths',
    afterUndo?.undo?.by === 'user' && afterUndo.undo.restored.length === 3 && afterUndo.undoable === false,
    JSON.stringify(afterUndo?.undo),
  );
  await shot('undone');

  // ------------------------------------------------------------------------- 4 another turn, then Retry
  // A complete reply has no Retry button; a stopped one does. So the second turn is stopped during its (slow) closing
  // text, after its files were written, and then retried: the way a user ends up retrying an Auto turn.
  await send('Again [fake:edit=a.txt] [fake:write=n.txt] [fake:slow]');
  await waitFor(`${CARDS}.length === 2`, 'second Auto card', 30000);
  await waitFor(
    `[...document.querySelectorAll('article')].at(-1)?.innerText.includes('The README')`,
    'closing text streaming',
    30000,
  );
  check('4 a second Auto card appears', (await cardCount()) === 2);
  check('4 the new card is undoable', (await lastCardAttr('data-undo')) === 'undoable');
  check('4 a.txt has the marker once after the second turn', countOf(read('a.txt'), MARKER) === 1);
  check('4 n.txt exists after the second turn', existsSync(file('n.txt')));
  await click(`document.querySelector('button[aria-label="Stop"]')`, 'Stop');
  await waitFor(`!!${byText('article button', 'Retry', true)} && ${settled}`, 'Retry button after stopping', 20000);
  check(
    '4 stopping kept the written files and the card',
    countOf(read('a.txt'), MARKER) === 1 && (await cardCount()) === 2,
  );
  // Waits on the retry's own progress: "not busy" alone is already true before it starts, and the stopped attempt's card
  // matches any card check. The retry adds a third batch, its card replaces the stopped attempt's, then it settles.
  const stoppedBatchId = await lastCardAttr('data-batch-id');
  const batchesBefore = (await autoBatches()).length;
  await click(byText('article button', 'Retry', true), 'Retry');
  const retried = await waitUntil(
    async () => {
      const all = await autoBatches();
      return all.length > batchesBefore ? all.at(-1) : null;
    },
    'the retry wrote a new batch',
    30000,
  );
  await waitFor(
    `${lastCard}?.getAttribute('data-batch-id') === ${JSON.stringify(retried.id)} && ${lastCard}.getAttribute('data-batch-id') !== ${JSON.stringify(stoppedBatchId)}`,
    "the retry's card",
    15000,
  );
  // The batch was written mid-run, so the conversation is busy here until the retry has settled.
  await waitFor(
    `${settled} && ${isIdle} && ${lastCard}.getAttribute('data-undo') === 'undoable'`,
    'retry settled',
    30000,
  );
  const afterRetry = read('a.txt');
  check(
    '4 after Retry a.txt has exactly one marker (the first attempt was undone)',
    afterRetry === `alpha line${MARKER}\nsecond a\n` && countOf(afterRetry, MARKER) === 1,
    JSON.stringify(afterRetry),
  );
  check('4 after Retry n.txt exists once, written by the second attempt', existsSync(file('n.txt')));
  const batches4 = await autoBatches();
  check('4 the server holds three auto batches now', batches4.length === 3, `${batches4.length}`);
  const [, attempt1, attempt2] = batches4;
  check(
    '4 the first attempt is recorded as undone by the retry',
    attempt1?.undo?.by === 'retry' && attempt1.undoable === false,
    JSON.stringify(attempt1?.undo),
  );
  check('4 the second attempt is undoable', attempt2?.undoable === true && attempt2.undo === undefined);
  check(
    '4 the card of the retried turn is the new, undoable batch',
    (await lastCardAttr('data-batch-id')) === attempt2?.id,
  );
  await shot('after-retry');

  // ------------------------------------------------------------------------- 5 a file edited on disk is skipped
  const userEdit = `alpha line${MARKER}\nsecond a\nthe user typed this\n`;
  writeFileSync(file('a.txt'), userEdit);
  await undoLastCard();
  check("5 the user's edit to a.txt is kept, byte for byte", read('a.txt') === userEdit, JSON.stringify(read('a.txt')));
  check('5 n.txt (untouched since) is removed', !existsSync(file('n.txt')));
  const skippedText = await ev(`${lastCard}.querySelector('[data-testid=undo-skipped]')?.innerText ?? ''`);
  check('5 the card names a.txt as left alone', /a\.txt/.test(skippedText), skippedText.replace(/\n/g, ' | '));
  check(
    '5 the card still reads as undone, with one file restored',
    (await lastCardAttr('data-undo')) === 'undone' && (await lastCardText()).includes('1 file restored'),
    (await lastCardText()).replace(/\n/g, ' | '),
  );
  const batch5 = (await autoBatches()).at(-1);
  check(
    '5 the server lists a.txt as skipped (changed since) and n.txt as restored',
    batch5?.undo?.skipped.length === 1 &&
      batch5.undo.skipped[0].path === 'a.txt' &&
      batch5.undo.skipped[0].reason === 'changed_since' &&
      batch5.undo.restored.join() === 'n.txt',
    JSON.stringify(batch5?.undo),
  );
  await shot('skipped');

  // ------------------------------------------------------------------------- 6 Review after Auto
  await pickMode('review');
  await waitFor(`${CHIP}?.getAttribute('data-mode') === 'review'`, 'chip Review');
  check('6 the chip reads Review', (await chipMode()) === 'review');
  check('6 switching back to Review did not open a dialog', await ev(`!${dialog}`));
  check('6 the chat is stored as Review', (await chatNow()).editMode === 'review');
  const cardsBefore = await cardCount();
  await say('Review this one [fake:edit=b.txt]');
  await waitFor(`!!${byText('[data-testid=changes-card]', 'Proposed edits')}`, 'Proposed edits card', 15000);
  check('6 a Proposed edits card appears', true);
  check('6 the edit is pending, not written', (await pendingPaths()).join() === 'b.txt', (await pendingPaths()).join());
  check('6 b.txt on disk is unchanged', sameBytes('b.txt'));
  check("6 a.txt keeps the user's edit", read('a.txt') === userEdit);
  check('6 no new Auto card was added', (await cardCount()) === cardsBefore);
  await shot('review-after-auto');

  // ------------------------------------------------------------------------- 7 reload: still Review, History
  const idBefore = await chatId();
  await reload();
  await waitFor(`!!document.querySelector('[data-testid=edit-mode-chip]')`, 'chip after reload', 20000);
  check('7 after a reload the chat is still Review', (await chipMode()) === 'review' && (await chatId()) === idBefore);
  check('7 the server still says Review', (await chatNow()).editMode === 'review');
  check('7 the Proposed edits card is back', await ev(`!!${byText('[data-testid=changes-card]', 'Proposed edits')}`));

  await openDiff();
  await waitFor(`!!${history}`, 'History');
  const bAuto = await autoBatches();
  const entries = await ev(
    `${historyEntries}.map((e) => ({ source: e.dataset.source, id: e.dataset.batchId, by: e.querySelector('[data-testid=undo-status]')?.getAttribute('data-by') ?? null, state: e.querySelector('[data-testid=undo-status]')?.getAttribute('data-state') ?? null, skipped: e.querySelector('[data-testid=undo-skipped]')?.innerText ?? '' }))`,
  );
  const autoEntries = entries.filter((e) => e.source === 'auto');
  check('7 the History is named "History"', true);
  check(
    '7 the History lists the three auto batches, newest first',
    autoEntries.length === 3 &&
      autoEntries.map((e) => e.id).join() ===
        [...bAuto]
          .reverse()
          .map((b) => b.id)
          .join(),
    autoEntries.map((e) => e.id.slice(0, 6)).join(),
  );
  check(
    '7 their undo results show: user, retry, user',
    autoEntries.map((e) => `${e.state}/${e.by}`).join() === 'undone/user,undone/retry,undone/user',
    autoEntries.map((e) => `${e.state}/${e.by}`).join(),
  );
  check(
    '7 the newest entry names the skipped a.txt',
    /a\.txt/.test(autoEntries[0]?.skipped ?? ''),
    autoEntries[0]?.skipped,
  );
  check(
    '7 the pending proposal is above the History in the panel',
    await ev(
      `!!(document.querySelector('section[aria-label="Review changes"] nav[aria-label="Changed files"]')?.compareDocumentPosition(${history}) & Node.DOCUMENT_POSITION_FOLLOWING)`,
    ),
  );
  await shot('history');
  await setPanel(false);

  // A new chat in the same project shows Review, and the acknowledged warning is not asked again.
  await newChatIn(PROJECT_NAME);
  check('7 a new chat in the same project shows Review', (await chipMode()) === 'review');
  await pickMode('auto');
  await waitFor(`${CHIP}?.getAttribute('data-mode') === 'auto'`, 'Auto without a dialog');
  check('7 the no-Git warning is not asked again for this project', await ev(`!${dialog}`));
  check('7 the other chat is still Review', (await api(`/chats/${idBefore}`)).body.editMode === 'review');
  await ev(`location.hash = '#/new'`);
  await waitFor(`document.body.innerText.includes('What are we building')`, 'new chat');
  await newChatIn(PROJECT_NAME);
  check('7 opening New chat again starts at Review', (await chipMode()) === 'review');
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
console.log(`\nauto/${MODE}: ${results.length - failed} passed, ${failed} failed`);
page.close();
process.exit(failed ? 1 : 0);
