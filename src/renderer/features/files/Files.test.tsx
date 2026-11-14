import { AppProviders, AppRoutes } from '@renderer/app/App';
import { renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { ApiError } from '@renderer/lib/api-client';
import { MockApiClient } from '@renderer/lib/mock-api-client';
import { queryKeys } from '@renderer/lib/query-keys';
import { useUiStore } from '@renderer/stores/ui';
import { errorInfo } from '@shared/errors';
import type { ProjectFileListing } from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanelStore } from '../right-panel/panel-store';
import {
  buildRows,
  FOLDER_ERROR,
  FOLDER_LOADING,
  FOLDER_TRUNCATED,
  type FolderState,
  type SearchShown,
  searchRows,
  searchView,
  type TreeRow,
  visibleExpandedFolders,
} from './tree';

beforeEach(() => {
  resetUi();
  usePanelStore.setState({ chats: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const panel = () => screen.getByRole('complementary', { name: 'Right panel' });
const filter = (q: string) =>
  fireEvent.change(within(panel()).getByRole('searchbox', { name: 'Filter files' }), { target: { value: q } });

async function openFiles() {
  const seed = await seededClient();
  renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
  await screen.findByRole('heading', { level: 1, name: seed.chat.title });
  fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
  await within(panel()).findByRole('navigation', { name: 'Project files' });
  await within(panel()).findByText('README.md');
  return seed;
}

async function openFile(query: string, name: RegExp) {
  filter(query);
  fireEvent.click(await within(panel()).findByRole('button', { name }));
  await within(panel()).findByRole('tabpanel');
}

describe('buildRows', () => {
  const listing = (path: string, entries: [string, 'dir' | 'file'][], truncated = false): ProjectFileListing => ({
    path,
    truncated,
    entries: entries.map(([p, type]) => ({ path: p, type })),
  });
  const root = listing('', [
    ['src', 'dir'],
    ['README.md', 'file'],
  ]);
  const src = listing('src', [
    ['src/a', 'dir'],
    ['src/b.ts', 'file'],
  ]);
  const a = listing('src/a', [['src/a/x.ts', 'file']]);
  const loaded: Record<string, FolderState> = {
    src: { status: 'success', listing: src },
    'src/a': { status: 'success', listing: a },
  };
  const paths = (rows: TreeRow[]) => rows.map((r) => (r.kind === 'entry' ? r.path : `[${r.text}]`));

  it('shows only children of expanded folders', () => {
    const folder = (d: string) => loaded[d];
    expect(paths(buildRows(root, folder, {}))).toEqual(['src', 'README.md']);
    expect(paths(buildRows(root, folder, { src: true }))).toEqual(['src', 'src/a', 'src/b.ts', 'README.md']);
    // A folder inside a collapsed one stays hidden even if it was left expanded.
    expect(paths(buildRows(root, folder, { 'src/a': true }))).toEqual(['src', 'README.md']);
    expect(paths(buildRows(root, folder, { src: true, 'src/a': true }))).toEqual([
      'src',
      'src/a',
      'src/a/x.ts',
      'src/b.ts',
      'README.md',
    ]);
  });

  it('shows a loading row at the child indent, a quiet row with a retry for a folder that failed, nothing if gone', () => {
    const rows = buildRows(root, (d) => (d === 'src' ? { status: 'pending' } : undefined), { src: true });
    expect(rows[1]).toEqual({ kind: 'status', key: 'pending:src', depth: 1, text: FOLDER_LOADING });
    const failed = buildRows(root, () => ({ status: 'error', message: 'Blocked by macOS.' }), { src: true });
    expect(paths(failed)).toEqual(['src', '[Blocked by macOS.]', 'README.md']);
    expect(failed[1]).toMatchObject({ kind: 'status', depth: 1, retry: 'src' });
    expect(paths(buildRows(root, () => ({ status: 'gone' }), { src: true }))).toEqual(['src', 'README.md']);
  });

  it('notes a truncated folder at that folder', () => {
    const big = listing('src', [['src/b.ts', 'file']], true);
    const rows = buildRows(root, () => ({ status: 'success', listing: big }), { src: true });
    expect(paths(rows)).toEqual(['src', 'src/b.ts', `[${FOLDER_TRUNCATED}]`, 'README.md']);
    expect(rows[2]).toMatchObject({ depth: 1 });
    expect(paths(buildRows({ ...root, truncated: true }, () => undefined, {})).at(-1)).toBe(`[${FOLDER_TRUNCATED}]`);
  });

  it('lists the expanded folders on screen, parents first', () => {
    expect(visibleExpandedFolders({ 'src/a': true, src: true, 'docs/x': true, lib: true })).toEqual([
      'lib',
      'src',
      'src/a',
    ]);
  });

  it('shows search results flat with a dimmed dir prefix', () => {
    expect(
      searchRows([
        { path: 'src/a/x.ts', type: 'file' },
        { path: 'src', type: 'dir' },
      ]),
    ).toEqual([{ kind: 'entry', path: 'src/a/x.ts', name: 'x.ts', dir: 'src/a/', isDir: false, depth: 0 }]);
  });
});

describe('searchView', () => {
  const result = (paths: string[], truncated: false | 'results' | 'scanned' = false) => ({
    entries: paths.map((p) => ({ path: p, type: 'file' as const })),
    truncated,
  });
  const shown = (term: string, paths: string[], scope = 'c:p'): SearchShown => ({ scope, term, result: result(paths) });
  const base = { scope: 'c:p', current: null, last: null, error: null };

  it('shows the answer for exactly the current text', () => {
    expect(searchView({ ...base, raw: 'zz', current: shown('zz', []) })).toEqual({
      kind: 'results',
      entries: [],
      truncated: false,
    });
  });
  it('narrows an earlier answer only when the new text extends its term, in the same scope', () => {
    const last = shown('read', ['README.md', 'src/read-file.ts']);
    expect(searchView({ ...base, raw: 'READ-f', last })).toEqual({
      kind: 'narrowing',
      entries: [{ path: 'src/read-file.ts', type: 'file' }],
    });
    expect(searchView({ ...base, raw: 'zzzz', last })).toEqual({ kind: 'searching' });
    expect(searchView({ ...base, raw: 'rea', last })).toEqual({ kind: 'searching' });
    expect(searchView({ ...base, raw: 'read-f', last: shown('read', ['src/read-file.ts'], 'other:p') })).toEqual({
      kind: 'searching',
    });
    // Nothing left after narrowing is not a "no match" answer.
    expect(searchView({ ...base, raw: 'readzz', last })).toEqual({ kind: 'searching' });
  });
  it('reports an error only for the current text', () => {
    const error = new Error('x');
    expect(searchView({ ...base, raw: 'a', error })).toEqual({ kind: 'error', error });
  });
});

describe('Files surface', () => {
  it('expands folders, filters, shows no-matches and collapses all', async () => {
    await openFiles();
    const nav = within(panel()).getByRole('navigation', { name: 'Project files' });
    const src = () => within(nav).getByRole('button', { name: /^src$/ });
    expect(src().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(src());
    expect(src().getAttribute('aria-expanded')).toBe('true');
    expect(await within(nav).findByRole('button', { name: /^core$/ })).toBeTruthy();

    filter('read-file');
    expect(await within(nav).findByRole('button', { name: /read-file\.ts/ })).toBeTruthy();
    filter('zzzz');
    expect(await within(panel()).findByText('No files match “zzzz”.')).toBeTruthy();
    filter('');

    fireEvent.click(within(panel()).getByRole('button', { name: 'Collapse all folders' }));
    expect(src().getAttribute('aria-expanded')).toBe('false');
    expect(within(nav).queryByRole('button', { name: /^core$/ })).toBeNull();
    expect(within(panel()).getByText(/Ignored and secret files are hidden/)).toBeTruthy();
  });

  it('fetches only the root up front, then a folder when it is expanded, with a loading row meanwhile', async () => {
    const seed = await seededClient();
    const spy = vi.spyOn(seed.client, 'listProjectFiles');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const real = MockApiClient.prototype.listProjectFiles;
    spy.mockImplementation(async function (this: MockApiClient, id, dir = '', signal) {
      if (dir === 'src') await gate;
      return real.call(this, id, dir, signal);
    });
    renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
    await screen.findByRole('heading', { level: 1, name: seed.chat.title });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
    const nav = await within(panel()).findByRole('navigation', { name: 'Project files' });
    await within(nav).findByText('README.md');
    expect(spy.mock.calls.map((c) => c[1] ?? '')).toEqual(['']);

    fireEvent.click(within(nav).getByRole('button', { name: /^src$/ }));
    expect(await within(nav).findByText('Loading…')).toBeTruthy();
    expect(spy.mock.calls.map((c) => c[1])).toContain('src');
    expect(spy.mock.calls.some((c) => c[1] === 'src/core')).toBe(false);
    release();
    expect(await within(nav).findByRole('button', { name: /^core$/ })).toBeTruthy();
    expect(within(nav).queryByText('Loading…')).toBeNull();
    const core = within(nav).getByRole('button', { name: /^core$/ });
    expect(core.style.paddingLeft).toBe('22px');
  });

  it('debounces the filter into one search, passes an abort signal, and keeps results while the next loads', async () => {
    const seed = await seededClient();
    const search = vi.spyOn(seed.client, 'searchProjectFiles');
    renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
    await screen.findByRole('heading', { level: 1, name: seed.chat.title });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
    const nav = await within(panel()).findByRole('navigation', { name: 'Project files' });
    await within(nav).findByText('README.md');

    filter('r');
    filter('re');
    filter('read');
    expect(search).not.toHaveBeenCalled();
    expect(await within(nav).findByRole('button', { name: /read-file\.ts/ })).toBeTruthy();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[1]).toBe('read');
    expect(search.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    // The folder prefix is dimmed, the name is not.
    const hit = within(nav).getByRole('button', { name: /read-file\.ts/ });
    expect(hit.textContent).toBe('src/core/tools/read-file.ts');

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const real = MockApiClient.prototype.searchProjectFiles;
    search.mockImplementation(async function (this: MockApiClient, id, q, signal) {
      await gate;
      return real.call(this, id, q, signal);
    });
    filter('read-f');
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    // Still the previous results while the new search runs.
    expect(within(nav).getByRole('button', { name: /read-file\.ts/ })).toBeTruthy();
    expect(within(nav).queryByText('Searching…')).toBeNull();
    release();
    await waitFor(() => expect(within(nav).queryByRole('button', { name: /README\.md/ })).toBeNull());
  });

  it('says when a search stopped at the result cap', async () => {
    const seed = await seededClient();
    vi.spyOn(seed.client, 'searchProjectFiles').mockResolvedValue({
      entries: [{ path: 'src/a.ts', type: 'file' }],
      truncated: 'results',
    });
    renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
    await screen.findByRole('heading', { level: 1, name: seed.chat.title });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
    await within(panel()).findByText('README.md');
    filter('a');
    expect(
      await within(panel()).findByText('Showing the first 1 matches. Keep typing to narrow it down.'),
    ).toBeTruthy();
    expect(within(panel()).queryByText(/part of this/)).toBeNull();
    expect(within(panel()).queryByText(/Use the filter/)).toBeNull();
  });

  it('says when a search stopped at the scan cap, with or without matches, in project or home words', async () => {
    const seed = await seededClient();
    const home = await seed.client.createChat({ projectId: null, model: 'm' });
    for (const [chat, place, spy] of [
      [seed.chat, 'project', vi.spyOn(seed.client, 'searchProjectFiles')],
      [home, 'folder', vi.spyOn(seed.client, 'searchHomeFiles')],
    ] as const) {
      spy.mockImplementation(async (...args: unknown[]) =>
        args.includes('a')
          ? { entries: [{ path: 'src/a.ts', type: 'file' }], truncated: 'scanned' }
          : { entries: [], truncated: 'scanned' },
      );
      const { unmount } = renderApp({ client: seed.client, route: `/chat/${chat.id}` });
      await screen.findByRole('heading', { level: 1, name: chat.title });
      fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
      await within(panel()).findByText('README.md');
      filter('a');
      expect(await within(panel()).findByRole('button', { name: /a\.ts/ })).toBeTruthy();
      expect(
        within(panel()).getByText(
          `Only part of this ${place} was searched because it is large, so some matching files may be missing.`,
        ),
      ).toBeTruthy();
      expect(within(panel()).queryByText(/Showing the first/)).toBeNull();

      filter('zzzz');
      // Zero matches in a partial search: one honest message, never a flat "No files match".
      expect(
        await within(panel()).findByText(
          `No matches for “zzzz” in the part of this ${place} that was searched. It is large, so some files were not searched.`,
        ),
      ).toBeTruthy();
      expect(within(panel()).queryByText(/No files match/)).toBeNull();
      expect(within(panel()).queryByText(/Showing the first/)).toBeNull();
      expect(within(panel()).queryByText(/so some matching files may be missing/)).toBeNull();
      unmount();
      resetUi();
      usePanelStore.setState({ chats: {} });
    }
  });

  /** Holds every project search until `release()`; the real mock answers afterwards. */
  function holdSearches(client: MockApiClient) {
    let release: () => void = () => {};
    let gate = new Promise<void>((r) => {
      release = r;
    });
    const real = MockApiClient.prototype.searchProjectFiles;
    const spy = vi.spyOn(client, 'searchProjectFiles');
    const hold = () => {
      gate = new Promise<void>((r) => {
        release = r;
      });
      spy.mockImplementation(async function (this: MockApiClient, id, q, signal) {
        await gate;
        return real.call(this, id, q, signal);
      });
    };
    const passThrough = () => spy.mockImplementation((id, q, signal) => real.call(client, id, q, signal));
    passThrough();
    return { spy, hold, release: () => release(), passThrough };
  }

  async function openPanelFor(client: MockApiClient, chat: { id: string; title: string }) {
    renderApp({ client, route: `/chat/${chat.id}` });
    await screen.findByRole('heading', { level: 1, name: chat.title });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
    const nav = await within(panel()).findByRole('navigation', { name: /files$/ });
    await within(nav).findByText('README.md');
    return nav;
  }

  it('after clearing the filter, an unrelated term shows "Searching…", never the old hits', async () => {
    const seed = await seededClient();
    const s = holdSearches(seed.client);
    const nav = await openPanelFor(seed.client, seed.chat);
    filter('read-file');
    expect(await within(nav).findByRole('button', { name: /read-file\.ts/ })).toBeTruthy();
    filter('');
    await within(nav).findByRole('button', { name: /^src$/ });
    // Let the cleared filter settle past the debounce.
    await new Promise((r) => setTimeout(r, 250));

    s.hold();
    filter('zzzz-nothing');
    // During the debounce, and while the search runs: nothing from "read-file", and it says so.
    expect(within(nav).queryByRole('button', { name: /read-file\.ts/ })).toBeNull();
    expect(within(nav).getByText('Searching…')).toBeTruthy();
    await waitFor(() => expect(s.spy.mock.calls.at(-1)?.[1]).toBe('zzzz-nothing'));
    expect(within(nav).queryByRole('button', { name: /read-file\.ts/ })).toBeNull();
    expect(within(nav).getByText('Searching…')).toBeTruthy();
    s.release();
    expect(await within(nav).findByText('No files match “zzzz-nothing”.')).toBeTruthy();
  });

  it('after a no-match result, another term never claims "No files match" before its own answer', async () => {
    const seed = await seededClient();
    const s = holdSearches(seed.client);
    const nav = await openPanelFor(seed.client, seed.chat);
    filter('zzzz');
    expect(await within(nav).findByText('No files match “zzzz”.')).toBeTruthy();

    s.hold();
    filter('read');
    expect(within(nav).queryByText(/No files match/)).toBeNull();
    expect(within(nav).getByText('Searching…')).toBeTruthy();
    await waitFor(() => expect(s.spy.mock.calls.at(-1)?.[1]).toBe('read'));
    expect(within(nav).queryByText(/No files match/)).toBeNull();
    expect(within(nav).getByText('Searching…')).toBeTruthy();
    s.release();
    expect(await within(nav).findByRole('button', { name: /read-file\.ts/ })).toBeTruthy();

    // Extending a no-match term: still no answer for the new text, so still "Searching…".
    s.passThrough();
    filter('zzzz');
    expect(await within(nav).findByText('No files match “zzzz”.')).toBeTruthy();
    s.hold();
    filter('zzzzz');
    expect(within(nav).queryByText(/No files match/)).toBeNull();
    expect(within(nav).getByText('Searching…')).toBeTruthy();
    s.release();
    expect(await within(nav).findByText('No files match “zzzzz”.')).toBeTruthy();
  });

  it('a term that extends the previous one keeps the previous hits, narrowed, until its answer arrives', async () => {
    const seed = await seededClient();
    const s = holdSearches(seed.client);
    const nav = await openPanelFor(seed.client, seed.chat);
    filter('READ');
    expect(await within(nav).findByRole('button', { name: /read-file\.ts/ })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: /README\.md/ })).toBeTruthy();

    s.hold();
    filter('read-');
    // Narrowed to the new text at once, during the debounce and while the search runs.
    expect(within(nav).getByRole('button', { name: /read-file\.ts/ })).toBeTruthy();
    expect(within(nav).queryByRole('button', { name: /README\.md/ })).toBeNull();
    await waitFor(() => expect(s.spy.mock.calls.at(-1)?.[1]).toBe('read-'));
    expect(within(nav).getByRole('button', { name: /read-file\.ts/ })).toBeTruthy();
    expect(within(nav).queryByText('Searching…')).toBeNull();
    s.release();
    await waitFor(() => expect(s.spy.mock.calls.at(-1)?.[1]).toBe('read-'));
    expect(await within(nav).findByRole('button', { name: /read-file\.ts/ })).toBeTruthy();
  });

  it("a chat on another root, with a remembered filter, never shows or opens the previous chat's hits", async () => {
    const seed = await seededClient();
    const home = await seed.client.createChat({ projectId: null, model: 'm' });
    await seed.client.updateChat(home.id, { title: 'Home chat' });
    usePanelStore.setState({
      chats: {
        [home.id]: { active: null, tabs: [], params: {}, expanded: {}, query: 'read', root: 'home' },
      },
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const homeSearch = vi.spyOn(seed.client, 'searchHomeFiles').mockImplementation(async (q) => {
      await gate;
      return { entries: [{ path: `notes/${q}-me.txt`, type: 'file' }], truncated: false };
    });
    const readProject = vi.spyOn(seed.client, 'readProjectFile');
    const readHome = vi.spyOn(seed.client, 'readHomeFile');

    const nav = await openPanelFor(seed.client, seed.chat);
    filter('read');
    expect(await within(nav).findByRole('button', { name: /read-file\.ts/ })).toBeTruthy();

    fireEvent.click(await screen.findByRole('link', { name: 'Home chat' }));
    const homeNav = await within(panel()).findByRole('navigation', { name: 'Home files' });
    expect((within(panel()).getByRole('searchbox', { name: 'Filter files' }) as HTMLInputElement).value).toBe('read');
    expect(within(homeNav).queryByRole('button', { name: /read-file\.ts/ })).toBeNull();
    expect(await within(homeNav).findByText('Searching…')).toBeTruthy();
    expect(within(homeNav).queryByRole('button', { name: /read-file\.ts/ })).toBeNull();
    // The remembered filter is searched right away, against home.
    await waitFor(() => expect(homeSearch).toHaveBeenCalledWith('read', expect.any(AbortSignal)));
    expect(within(homeNav).queryByRole('button', { name: /read-file\.ts/ })).toBeNull();
    release();
    fireEvent.click(await within(homeNav).findByRole('button', { name: /read-me\.txt/ }));
    await within(panel()).findByRole('tabpanel');
    expect(readProject).not.toHaveBeenCalled();
    expect(readHome.mock.calls.map((c) => c[0])).toEqual(['notes/read-me.txt']);
  });

  it('a subfolder that fails shows the server message and retries just that folder', async () => {
    const seed = await seededClient();
    const denial =
      'macOS blocked access to this folder. Allow access in System Settings › Privacy & Security › Files & Folders.';
    const real = MockApiClient.prototype.listProjectFiles;
    let failures = 1;
    const spy = vi.spyOn(seed.client, 'listProjectFiles').mockImplementation(async function (
      this: MockApiClient,
      id,
      dir = '',
      signal,
    ) {
      if (dir === 'src' && failures-- > 0) throw new ApiError(errorInfo('path_invalid', denial), 400);
      return real.call(this, id, dir, signal);
    });
    const nav = await openPanelFor(seed.client, seed.chat);
    fireEvent.click(within(nav).getByRole('button', { name: /^src$/ }));
    expect(await within(nav).findByText(denial)).toBeTruthy();
    expect(within(nav).queryByText("Couldn't load this folder.")).toBeNull();
    const retry = within(nav).getByRole('button', { name: 'Try again to load src' });
    expect(retry.textContent).toBe('Try again');
    const before = spy.mock.calls.length;
    fireEvent.click(retry);
    expect(await within(nav).findByRole('button', { name: /^core$/ })).toBeTruthy();
    expect(within(nav).queryByText(denial)).toBeNull();
    expect(spy.mock.calls.slice(before).map((c) => c[1])).toEqual(['src']);
  });

  it('a subfolder that fails without a server message falls back to the generic text', async () => {
    const seed = await seededClient();
    const real = MockApiClient.prototype.listProjectFiles;
    vi.spyOn(seed.client, 'listProjectFiles').mockImplementation(async function (
      this: MockApiClient,
      id,
      dir = '',
      signal,
    ) {
      if (dir === 'src') throw new TypeError('boom');
      return real.call(this, id, dir, signal);
    });
    const nav = await openPanelFor(seed.client, seed.chat);
    fireEvent.click(within(nav).getByRole('button', { name: /^src$/ }));
    expect(await within(nav).findByText(FOLDER_ERROR, {}, { timeout: 3000 })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Try again to load src' })).toBeTruthy();
  });

  it('says when a folder is truncated, at that folder', async () => {
    const seed = await seededClient();
    const real = MockApiClient.prototype.listProjectFiles;
    vi.spyOn(seed.client, 'listProjectFiles').mockImplementation(async function (this: MockApiClient, id, dir = '') {
      const listing = await real.call(this, id, dir);
      return dir === 'docs' ? { ...listing, truncated: true } : listing;
    });
    renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
    await screen.findByRole('heading', { level: 1, name: seed.chat.title });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
    const nav = await within(panel()).findByRole('navigation', { name: 'Project files' });
    await within(nav).findByText('README.md');
    expect(within(nav).queryByText(/This folder is large/)).toBeNull();
    fireEvent.click(within(nav).getByRole('button', { name: /^docs$/ }));
    const note = await within(nav).findByText('This folder is large, so only part of it is listed.');
    // Right after the folder's own children, before the next top-level folder.
    const items = within(nav)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items.indexOf(note.textContent)).toBe(items.indexOf('design') + 1);
    expect(items[items.indexOf(note.textContent) + 1]).toBe('scripts');
  });

  it('never requests a remembered folder that is gone, and stays quiet (no error row, no retry) when one vanishes', async () => {
    const seed = await seededClient();
    usePanelStore.setState({
      chats: {
        [seed.chat.id]: {
          active: null,
          tabs: [],
          params: {},
          expanded: { gone: true, 'gone/deeper': true, src: true },
          query: '',
          root: `project:${seed.project.id}`,
        },
      },
    });
    const real = MockApiClient.prototype.listProjectFiles;
    const spy = vi.spyOn(seed.client, 'listProjectFiles').mockImplementation(async function (
      this: MockApiClient,
      id,
      dir = '',
    ) {
      if (dir === 'src') throw new ApiError(errorInfo('not_found', 'Folder not found: src'), 404);
      return real.call(this, id, dir);
    });
    renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
    await screen.findByRole('heading', { level: 1, name: seed.chat.title });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
    const nav = await within(panel()).findByRole('navigation', { name: 'Project files' });
    await within(nav).findByText('README.md');
    await waitFor(() => expect(spy.mock.calls.map((c) => c[1])).toContain('src'));
    // Once the 404 lands the folder reads like an empty one: no loading row, no error row.
    await waitFor(() => expect(within(nav).queryByText('Loading…')).toBeNull());
    expect(within(nav).getByRole('button', { name: /^src$/ }).getAttribute('aria-expanded')).toBe('true');
    expect(within(nav).queryByText("Couldn't load this folder.")).toBeNull();
    expect(within(nav).queryByText(/Folder not found/)).toBeNull();
    const dirs = spy.mock.calls.map((c) => c[1] ?? '');
    expect(dirs).not.toContain('gone');
    expect(dirs).not.toContain('gone/deeper');
    // A 404 is not retried.
    expect(dirs.filter((d) => d === 'src')).toHaveLength(1);
    expect(within(nav).getByText('README.md')).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: /Try again/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('home: lazy folders and search use the home endpoints; the viewer title reuses the root listing', async () => {
    const seed = await seededClient();
    const chat = await seed.client.createChat({ projectId: null, model: 'm' });
    const list = vi.spyOn(seed.client, 'listHomeFiles');
    const search = vi.spyOn(seed.client, 'searchHomeFiles');
    const project = vi.spyOn(seed.client, 'listProjectFiles');
    renderApp({ client: seed.client, route: `/chat/${chat.id}` });
    await screen.findByRole('heading', { level: 1, name: chat.title });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
    const nav = await within(panel()).findByRole('navigation', { name: 'Home files' });
    await within(nav).findByText('README.md');
    fireEvent.click(within(nav).getByRole('button', { name: /^docs$/ }));
    expect(await within(nav).findByRole('button', { name: /^design$/ })).toBeTruthy();
    await openFile('tokens', /tokens\.css/);
    expect(search.mock.calls[0]?.[0]).toBe('tokens');
    expect(within(panel()).getByRole('button', { name: '/home/you' })).toBeTruthy();
    // Only the root and the expanded folder were listed: no whole-tree fetch for the title. (The viewer shares the
    // root query; with the tests' `staleTime: 0` its mount may refetch that same root listing.)
    expect(new Set(list.mock.calls.map((c) => c[0] ?? ''))).toEqual(new Set(['', 'docs']));
    expect(project).not.toHaveBeenCalled();
  });

  it('opening the panel refreshes the project or home listings by prefix', async () => {
    const seed = await seededClient();
    const home = await seed.client.createChat({ projectId: null, model: 'm' });
    for (const [chat, prefix] of [
      [seed.chat, ['projectFiles', seed.project.id]],
      [home, ['homeFiles']],
    ] as const) {
      const { queryClient, unmount } = renderApp({ client: seed.client, route: `/chat/${chat.id}` });
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await screen.findByRole('heading', { level: 1, name: chat.title });
      fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
      await within(panel()).findByText('README.md');
      const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
      expect(keys).toContain(JSON.stringify(prefix));
      unmount();
      resetUi();
    }
  });

  it('opens a file tab with its line count; closing falls back to the neighbour, then Files', async () => {
    await openFiles();
    await openFile('README', /README\.md/);
    expect(await within(panel()).findByText('3 lines')).toBeTruthy();
    expect(within(panel()).getByRole('tab', { name: 'README.md', selected: true })).toBeTruthy();
    expect(within(panel()).getByRole('tabpanel', { name: 'README.md' }).textContent).toContain('# OpenVern');

    fireEvent.click(within(panel()).getByRole('tab', { name: 'Files' }));
    await openFile('tokens.css', /tokens\.css/);
    expect(within(panel()).getByRole('tab', { name: 'tokens.css', selected: true })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('tab', { name: 'README.md' }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close README.md' }));
    expect(within(panel()).getByRole('tab', { name: 'tokens.css', selected: true })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close tokens.css' }));
    expect(within(panel()).getByRole('tab', { name: 'Files', selected: true })).toBeTruthy();
  });

  it('Attach adds the file to the reply composer', async () => {
    await openFiles();
    await openFile('README', /README\.md/);
    await within(panel()).findByText('3 lines');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(screen.getAllByTestId('attachment-chip')).toHaveLength(1));
    expect(screen.getByTestId('attachment-chip').textContent).toContain('README.md');
  });

  it.each(['', 'notes'])(
    'while the project is not known yet, cached home answers are never shown (filter %j)',
    async (query) => {
      const seed = await seededClient();
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const listChats = seed.client.listChats.bind(seed.client);
      vi.spyOn(seed.client, 'listChats').mockImplementation(async () => {
        await gate;
        return listChats();
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
      // Left in the cache by an earlier chat without a project.
      queryClient.setQueryData(queryKeys.homeFolder(''), {
        root: '/home/you',
        path: '',
        truncated: false,
        entries: [{ path: 'HOME-NOTES.txt', type: 'file' }],
      });
      queryClient.setQueryData(queryKeys.homeFileSearch('notes'), {
        truncated: false,
        entries: [{ path: 'private/HOME-notes.txt', type: 'file' }],
      });
      if (query) {
        usePanelStore.setState({
          chats: { [seed.chat.id]: { active: null, tabs: [], params: {}, expanded: {}, query } },
        });
      }
      useUiStore.setState({ rightPanelOpen: true });
      render(
        <AppProviders client={seed.client} queryClient={queryClient}>
          <MemoryRouter initialEntries={[`/chat/${seed.chat.id}`]}>
            <AppRoutes />
          </MemoryRouter>
        </AppProviders>,
      );
      const nav = await within(panel()).findByRole('navigation', { name: 'Project files' });
      expect(within(nav).queryByRole('button', { name: /HOME-/i })).toBeNull();

      release();
      // Once the project is known, its own files are listed (or searched) and the home ones still never appear.
      if (!query) await within(panel()).findByText('README.md');
      await waitFor(() => expect(within(panel()).queryByText(/Loading files|Searching/)).toBeNull());
      expect(within(panel()).queryByRole('button', { name: /HOME-/i })).toBeNull();
    },
  );
});

describe('AS-08 Files error states', () => {
  async function show(list: 'error' | 'empty') {
    const seed = await seededClient();
    const spy = vi.spyOn(seed.client, 'listProjectFiles');
    if (list === 'error')
      spy.mockRejectedValue(
        new ApiError(
          errorInfo(
            'path_invalid',
            'macOS blocked access to this folder. Allow access in System Settings › Privacy & Security › Files & Folders.',
          ),
          400,
        ),
      );
    else spy.mockResolvedValue({ path: '', entries: [], truncated: false });
    renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
    await screen.findByRole('heading', { level: 1, name: seed.chat.title });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle right panel' }));
    return spy;
  }
  it('A8-7a shows the denial and retries', async () => {
    const spy = await show('error');
    const message =
      'macOS blocked access to this folder. Allow access in System Settings › Privacy & Security › Files & Folders.';
    expect(await within(panel()).findByText(message)).toBeTruthy();
    expect(within(panel()).queryByText('This project has no files.')).toBeNull();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(await within(panel()).findByText(message)).toBeTruthy();
  });
  it('A8-7b shows the empty state', async () => {
    await show('empty');
    expect(await within(panel()).findByText('This project has no files.')).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
