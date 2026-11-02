import { renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanelStore } from '../right-panel/panel-store';
import { buildRows } from './tree';

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
  fireEvent.click(within(panel()).getByRole('button', { name }));
  await within(panel()).findByRole('tabpanel');
}

describe('buildRows', () => {
  const entries = [
    { path: 'src', type: 'dir' as const },
    { path: 'src/a', type: 'dir' as const },
    { path: 'src/a/x.ts', type: 'file' as const },
    { path: 'src/b.ts', type: 'file' as const },
    { path: 'README.md', type: 'file' as const },
  ];
  it('shows only children of expanded folders', () => {
    expect(buildRows(entries, {}, '').map((r) => r.path)).toEqual(['src', 'README.md']);
    expect(buildRows(entries, { src: true }, '').map((r) => r.path)).toEqual(['src', 'src/a', 'src/b.ts', 'README.md']);
    // A folder inside a collapsed one stays hidden even if it was left expanded.
    expect(buildRows(entries, { 'src/a': true }, '').map((r) => r.path)).toEqual(['src', 'README.md']);
  });
  it('filters flat with a dimmed dir prefix', () => {
    expect(buildRows(entries, {}, 'X.TS')).toEqual([
      { path: 'src/a/x.ts', name: 'x.ts', dir: 'src/a/', isDir: false, depth: 0 },
    ]);
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

    filter('read-file');
    expect(within(nav).getByRole('button', { name: /read-file\.ts/ })).toBeTruthy();
    filter('zzzz');
    expect(within(panel()).getByText('No files match “zzzz”.')).toBeTruthy();
    filter('');

    fireEvent.click(within(panel()).getByRole('button', { name: 'Collapse all folders' }));
    expect(src().getAttribute('aria-expanded')).toBe('false');
    expect(within(panel()).getByText(/Ignored and secret files are hidden/)).toBeTruthy();
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
});
