// F2 end-to-end: archiving chats through the real UI and the real backend, with the fake provider (plan §6 F2.6).
//   1 a project chat with one message · 2 Archive → gone from the active list, count − 1, "Archived 1", crumb
//   3 expand Archived, open the chat → aria-current · 4 Unarchive → back in the list, toggle gone
//   5 Archive again, reload → still under Archived (the backend agrees) · 6 a loose chat archives into "Chats"
// Same env as edits.mjs: E2E_MODE, E2E_BASE, E2E_OUT, CDP_PORT. Run through the runners (after edits).
//
// Assertions go through the DOM text and roles of the sidebar and header, never CSS classes. The sidebar helpers
// below find a project's row by its button text ("<name><count>") and its Archived toggle by "Archived<count>".

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';

const MODE = process.env.E2E_MODE ?? 'web';
const BASE = process.env.E2E_BASE ?? 'http://localhost:5173/';
const OUT = process.env.E2E_OUT;
const PORT = process.env.CDP_PORT;
if (!OUT || !PORT) throw new Error('E2E_OUT and CDP_PORT are required');
const electron = MODE === 'electron';

const PROJECT = join(OUT, 'fixtures', 'archive-proj');
mkdirSync(PROJECT, { recursive: true });
writeFileSync(join(PROJECT, 'README.md'), '# Archive fixture\n\nA project for the archive e2e run.\n');

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const note = (line) => console.log(`NOTE ${line}`);

const page = await connect(PORT, { urlPrefix: electron ? 'app://' : undefined });
const { ev, waitFor, click, key, type, byText } = page;
const shot = (name) => page.screenshot(join(OUT, `archive-${name}.png`));

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

/**
 * Page-side sidebar and header queries, as one IIFE expression. `where` is a project's name, or 'chats' for the
 * loose "Chats" section. Methods returning elements are for `click()`; the rest return JSON values.
 */
const H = `(() => {
  const norm = (e) => (e ? e.textContent : '').trim();
  const linkSel = (id) => 'a[href="#/chat/' + id + '"]';
  const projectBtn = (name) =>
    [...document.querySelectorAll('aside button[aria-expanded]')].find((b) => {
      const t = norm(b);
      return t.startsWith(name) && /^\\d+$/.test(t.slice(name.length));
    }) ?? null;
  const chatsSection = () =>
    [...document.querySelectorAll('aside section')].find((s) => norm(s.querySelector('h2')) === 'Chats') ?? null;
  // A project's row root holds its button and, when expanded, its list of chats.
  const scope = (where) => (where === 'chats' ? chatsSection() : projectBtn(where)?.parentElement?.parentElement) ?? null;
  const toggle = (where) =>
    [...(scope(where)?.querySelectorAll('button[aria-expanded]') ?? [])].find((b) => /^Archived\\d+$/.test(norm(b))) ?? null;
  // Direct children of the list: active chats only (archived ones sit one level deeper, inside the group).
  const activeLink = (where, id) => !!scope(where)?.querySelector(':scope > ul > li > ' + linkSel(id));
  const anyLink = (where, id) => !!scope(where)?.querySelector(linkSel(id));
  return {
    count: (name) => {
      const b = projectBtn(name);
      return b ? Number(norm(b).slice(name.length)) : null;
    },
    projectExpanded: (name) => projectBtn(name)?.getAttribute('aria-expanded') === 'true',
    projectBtnEl: (name) => projectBtn(name),
    toggle: (where) => {
      const b = toggle(where);
      return b ? { count: Number(norm(b).slice('Archived'.length)), expanded: b.getAttribute('aria-expanded') === 'true' } : null;
    },
    toggleEl: (where) => toggle(where),
    activeLink,
    archivedLinkVisible: (where, id) => anyLink(where, id) && !activeLink(where, id),
    current: (id) => document.querySelector('aside ' + linkSel(id))?.getAttribute('aria-current') ?? null,
    crumb: () => document.querySelector('main header')?.textContent ?? '',
  };
})()`;
const call = (method, ...args) => `(${H}).${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
const dom = (method, ...args) => ev(call(method, ...args));

const reload = async () => {
  await page.send('Page.reload');
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#root')?.children.length`, 'reload');
  await sleep(400);
};
const gotoHash = async (hash) => {
  await ev(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(250);
};

async function send(message) {
  await type('textarea', message);
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
  await waitFor(`${isIdle} && document.body.innerText.includes(${JSON.stringify(FINAL_ANSWER)})`, 'fake reply', 25000);
  await sleep(400);
  return chatId();
}

/** Archive / Unarchive from the chat header's "…" menu. The item is disabled while a reply streams. */
async function chatOption(label) {
  await click(`document.querySelector('button[aria-label="Chat options"]')`, 'Chat options');
  await waitFor(`!!${byText('[role=menuitem]', label, true)}`, `menu item ${label}`);
  await click(byText('[role=menuitem]', label, true), label);
}

/** Makes sure a project row is expanded (after a reload nothing is open until a chat on screen expands it). */
async function expandProject(name) {
  if (!(await dom('projectExpanded', name))) await click(call('projectBtnEl', name), `project ${name}`);
  await waitFor(`${call('projectExpanded', name)} === true`, `project ${name} expanded`);
}

/** Opens an "Archived" toggle (a project's, or the loose "Chats" one) if it is collapsed. */
async function expandArchived(where) {
  const t = await dom('toggle', where);
  if (t && !t.expanded) await click(call('toggleEl', where), `Archived (${where})`);
  await waitFor(`${call('toggle', where)}?.expanded === true`, `Archived (${where}) open`);
}

// ----------------------------------------------------------------------------------------------- setup
await page.viewport(1440, 900);
await page.send('Page.navigate', { url: `${BASE}#/new` });
await waitFor(`document.body.innerText.includes('What are we building')`, 'app loaded');
await sleep(500);
if (!(await api('/settings')).body.openRouter.configured) {
  const r = await api('/settings/openrouter-key', 'PUT', { apiKey: 'sk-or-v1-0123456789abcdefa1b2' });
  if (r.status !== 200) throw new Error(`could not set the fake key: ${r.status}`);
}
let project = (await api('/projects')).body.find((p) => p.rootPath === PROJECT);
if (!project) {
  const added = await api('/projects', 'POST', { rootPath: PROJECT });
  if (added.status !== 200 && added.status !== 201) throw new Error(`could not add the project: ${added.status}`);
  project = added.body;
}
const NAME = project.name;
await reload();
await waitFor(`${call('count', NAME)} !== null`, 'project row');

try {
  // ------------------------------------------------------------------------- 1 a project chat with one message
  const id = await startChat(NAME, 'Archive this project chat');
  const bubbles = await ev(`document.querySelectorAll('[data-testid=user-bubble]').length`);
  check(
    '1 the chat has one user message and the fake reply',
    bubbles === 1 && (await ev(`document.body.innerText.includes(${JSON.stringify(FINAL_ANSWER)})`)),
    `bubbles=${bubbles}`,
  );
  await waitFor(`${call('count', NAME)} === 1`, 'project row count 1');
  check('1 the project row counts the chat (1)', (await dom('count', NAME)) === 1);
  check('1 the chat is in the active list', await dom('activeLink', NAME, id));

  // ------------------------------------------------------------------------- 2 Archive from the header
  const before = await dom('count', NAME);
  await chatOption('Archive');
  await waitFor(`!${call('activeLink', NAME, id)}`, 'chat left the active list');
  const after = await dom('count', NAME);
  check("2 the chat is gone from the project's active list", !(await dom('activeLink', NAME, id)));
  check(`2 the project row count drops by 1 (${before} → ${after})`, after === before - 1);
  await waitFor(`${call('toggle', NAME)}?.count === 1`, 'Archived 1 toggle');
  const open = await dom('toggle', NAME);
  check('2 the project shows an "Archived 1" toggle', open?.count === 1, JSON.stringify(open));
  await waitFor(`${call('crumb')}.startsWith(${JSON.stringify(`${NAME} · Archived /`)})`, 'crumb archived');
  check(
    '2 the header crumb reads "… · Archived /"',
    (await dom('crumb')).startsWith(`${NAME} · Archived /`),
    (await dom('crumb')).slice(0, 60),
  );
  await shot('archived');
  // The open chat's group auto-expands while the archived chat is on screen (the "same as loose chats" rule).
  note(`Archived group right after archiving the open chat: expanded=${open?.expanded}`);

  // Starts collapsed: a fresh load with no archived chat on screen.
  await gotoHash('#/new');
  await reload();
  await waitFor(`${call('count', NAME)} !== null`, 'project row after reload');
  await expandProject(NAME);
  const collapsed = await dom('toggle', NAME);
  check(
    '2 the Archived toggle starts collapsed',
    collapsed?.count === 1 && collapsed.expanded === false,
    JSON.stringify(collapsed),
  );

  // ------------------------------------------------------------------------- 3 expand, open the archived chat
  await expandArchived(NAME);
  check('3 expanded: the archived chat is listed under Archived', await dom('archivedLinkVisible', NAME, id));
  await click(`document.querySelector(${JSON.stringify(`aside a[href="#/chat/${id}"]`)})`, 'archived chat link');
  await waitFor(hashIs(id), 'chat opened from Archived');
  await waitFor(`${call('current', id)} === 'page'`, 'aria-current');
  check('3 the opened archived chat is aria-current="page"', (await dom('current', id)) === 'page');

  // ------------------------------------------------------------------------- 4 Unarchive
  await chatOption('Unarchive');
  await waitFor(`${call('activeLink', NAME, id)}`, 'back in the active list');
  check('4 the chat is back in the active list', await dom('activeLink', NAME, id));
  check('4 the Archived toggle is gone', (await dom('toggle', NAME)) === null);
  check('4 the project row count is back to 1', (await dom('count', NAME)) === 1);
  check('4 the header crumb reads "name /" again', (await dom('crumb')).startsWith(`${NAME} /`));
  check('4 the backend agrees: archived is false', (await api(`/chats/${id}`)).body.archived === false);

  // ------------------------------------------------------------------------- 5 archive again, reload
  await chatOption('Archive');
  await waitFor(`!${call('activeLink', NAME, id)}`, 'archived again');
  check('5 the backend stores archived: true', (await api(`/chats/${id}`)).body.archived === true);
  await gotoHash('#/new');
  await reload();
  await waitFor(`${call('count', NAME)} !== null`, 'project row after reload');
  await expandProject(NAME);
  const persisted = await dom('toggle', NAME);
  check('5 after a reload the chat is still under "Archived 1"', persisted?.count === 1, JSON.stringify(persisted));
  check('5 after a reload the chat is not in the active list', !(await dom('activeLink', NAME, id)));
  await expandArchived(NAME);
  check('5 after a reload the archived chat is listed again', await dom('archivedLinkVisible', NAME, id));

  // ------------------------------------------------------------------------- 6 loose chat regression
  const looseId = await startChat(null, 'Loose archive check');
  const loose = (await api(`/chats/${looseId}`)).body;
  check('6 the loose chat has no project', loose.projectId === null, String(loose.projectId));
  const looseBefore = (await dom('toggle', 'chats'))?.count ?? 0;
  await chatOption('Archive');
  await waitFor(`${call('toggle', 'chats')}?.count === ${looseBefore + 1}`, 'loose Archived toggle');
  await waitFor(`!${call('activeLink', 'chats', looseId)}`, 'loose chat left the Chats list');
  check(
    '6 the loose chat is under the "Chats" section\'s Archived toggle',
    (await dom('toggle', 'chats'))?.count === looseBefore + 1,
    JSON.stringify(await dom('toggle', 'chats')),
  );
  check('6 the loose chat has left the Chats list', !(await dom('activeLink', 'chats', looseId)));
  check(
    '6 header crumb reads "Archived /"',
    (await dom('crumb')).startsWith('Archived /'),
    (await dom('crumb')).slice(0, 40),
  );
  await gotoHash('#/new');
  await waitFor(`${call('toggle', 'chats')} !== null`, 'Chats Archived toggle after leaving the chat');
  await expandArchived('chats');
  check('6 expanded: the archived loose chat is listed in "Chats"', await dom('archivedLinkVisible', 'chats', looseId));
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
console.log(`\narchive/${MODE}: ${results.length - failed} passed, ${failed} failed`);
page.close();
process.exit(failed ? 1 : 0);
