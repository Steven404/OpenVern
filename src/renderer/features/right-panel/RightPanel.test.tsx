import { openMenu, renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { sampleProposal } from '@renderer/lib/mock-changes';
import { readPersistedUi, STORAGE_KEYS } from '@renderer/stores/ui';
import { LAYOUT } from '@shared/constants';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanelStore } from './panel-store';

beforeEach(() => {
  resetUi();
  usePanelStore.setState({ chats: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const toggle = () => screen.getByRole('button', { name: 'Toggle right panel' });
const panel = () => screen.getByRole('complementary', { name: 'Right panel' });

async function renderChat(opts: { loose?: boolean } = {}) {
  const seed = await seededClient();
  const chat = opts.loose ? await seed.client.createChat({ projectId: null, model: 'm' }) : seed.chat;
  const view = renderApp({ client: seed.client, route: `/chat/${chat.id}` });
  await screen.findByRole('heading', { level: 1, name: chat.title });
  return { ...seed, ...view, chat };
}

const openPanel = () => fireEvent.click(toggle());
/** The primary modifier, as Windows/Linux (`Ctrl`) and macOS (`Cmd`) send it. Every shortcut must accept both. */
const MODIFIERS: { label: string; init: Record<string, boolean> }[] = [
  { label: 'Ctrl', init: { ctrlKey: true } },
  { label: 'Cmd', init: { metaKey: true } },
];
const pressBracket = (init: Record<string, boolean> = { ctrlKey: true }) =>
  fireEvent.keyDown(window, { key: ']', ...init });
const ctrlBracket = () => pressBracket();

/** Stubs a macOS or Linux navigator. Every field is set, so detection agrees with itself. */
function stubPlatform(platform: 'mac' | 'linux') {
  vi.stubGlobal(
    'navigator',
    platform === 'mac'
      ? { userAgentData: { platform: 'macOS' }, platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' }
      : {
          userAgentData: { platform: 'Linux' },
          platform: 'Linux x86_64',
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
        },
  );
}

describe('right panel shell', () => {
  it.each(MODIFIERS)('toggles from the header and $label+], with aria state', async ({ init }) => {
    await renderChat();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().getAttribute('aria-controls')).toBe('right-panel');
    openPanel();
    expect(panel()).toBeTruthy();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    pressBracket(init);
    expect(screen.queryByRole('complementary', { name: 'Right panel' })).toBeNull();
    pressBracket(init);
    expect(panel()).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('complementary', { name: 'Right panel' })).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it('persists the open state', async () => {
    await renderChat();
    openPanel();
    expect(window.localStorage.getItem(STORAGE_KEYS.rightPanelOpen)).toBe('1');
    expect(readPersistedUi().rightPanelOpen).toBe(true);
    ctrlBracket();
    expect(readPersistedUi().rightPanelOpen).toBe(false);
  });

  it.each(MODIFIERS)('ignores $label+] while a dialog is open', async ({ init }) => {
    await renderChat();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    pressBracket(init);
    expect(screen.queryByRole('complementary', { name: 'Right panel' })).toBeNull();
    dialog.remove();
    pressBracket(init);
    expect(panel()).toBeTruthy();
  });

  it.each(MODIFIERS)('ignores $label+] while a menu is open', async ({ init }) => {
    await renderChat();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    pressBracket(init);
    expect(screen.queryByRole('complementary', { name: 'Right panel' })).toBeNull();
    menu.remove();
    pressBracket(init);
    expect(panel()).toBeTruthy();
  });

  it.each([
    ['macOS', 'mac', 'Toggle right panel (⌘ ])'],
    ['Linux', 'linux', 'Toggle right panel (Ctrl ])'],
  ] as const)(
    'labels the header button for %s: tooltip shows the shortcut, accessible name is unchanged',
    async (_os, platform, tooltip) => {
      stubPlatform(platform);
      await renderChat();
      expect(toggle().getAttribute('title')).toBe(tooltip);
      expect(toggle().getAttribute('aria-label')).toBe('Toggle right panel');
      openPanel();
      expect(toggle().getAttribute('aria-pressed')).toBe('true');
    },
  );

  it('labels the new chat screen toggle with ⌘ on macOS', async () => {
    stubPlatform('mac');
    renderApp({ route: '/new' });
    await screen.findByRole('heading', { name: 'What are we building?' });
    expect(toggle().getAttribute('title')).toBe('Toggle right panel (⌘ ])');
  });

  it('opens on Files in a project chat', async () => {
    await renderChat();
    openPanel();
    expect(within(panel()).getByRole('tab', { name: 'Files', selected: true })).toBeTruthy();
    expect(await within(panel()).findByRole('navigation', { name: 'Project files' })).toBeTruthy();
  });
});

describe('launcher rules', () => {
  it('Terminal is always disabled; Diff is disabled until the chat has edits', async () => {
    await renderChat();
    openPanel();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Open a panel' }));
    const terminal = within(panel()).getByRole('button', { name: /Terminal/ }) as HTMLButtonElement;
    const diff = within(panel()).getByRole('button', { name: /Diff/ }) as HTMLButtonElement;
    expect(terminal.disabled).toBe(true);
    expect(terminal.textContent).toContain('Not available yet');
    expect(diff.disabled).toBe(true);
    expect(diff.textContent).toContain('Available after the current chat has made edits');
    expect((within(panel()).getByRole('button', { name: /^Files/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Diff is enabled once the chat has pending edits, and opens as a closable tab', async () => {
    const { client, chat } = await renderChat();
    vi.spyOn(client, 'getChatChanges').mockResolvedValue({
      pending: { revision: 1, messageId: 'm1', files: sampleProposal(), totalAdd: 1, totalDel: 0 },
      applied: [],
    });
    cleanup();
    renderApp({ client, route: `/chat/${chat.id}` });
    await screen.findByRole('heading', { level: 1, name: chat.title });
    openPanel();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Open a panel' }));
    const diff = within(panel()).getByRole('button', { name: /Diff/ }) as HTMLButtonElement;
    await waitFor(() => expect(diff.disabled).toBe(false));
    fireEvent.click(diff);
    expect(within(panel()).getByRole('tab', { name: 'Diff', selected: true })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close Diff' }));
    expect(within(panel()).getByRole('tab', { name: 'Files', selected: true })).toBeTruthy();
  });

  it('F opens Files from the launcher', async () => {
    await renderChat();
    openPanel();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Open a panel' }));
    fireEvent.keyDown(within(panel()).getByRole('heading', { name: 'Open a panel' }), { key: 'f' });
    expect(within(panel()).getByRole('tab', { name: 'Files', selected: true })).toBeTruthy();
  });

  it('a chat without a project browses the home folder', async () => {
    await renderChat({ loose: true });
    openPanel();
    expect(await within(panel()).findByText('/home/you')).toBeTruthy();
    expect(within(panel()).getByRole('navigation', { name: 'Home files' })).toBeTruthy();
    expect(within(panel()).getByRole('tab', { name: 'Files', selected: true })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Open a panel' }));
    const files = within(panel()).getByRole('button', { name: /^Files/ }) as HTMLButtonElement;
    expect(files.disabled).toBe(false);
    expect(files.textContent).toContain('Browse your home folder, read-only');
  });
});

describe('new chat screen', () => {
  it('shows the toggle and opens the home folder when no project is selected', async () => {
    renderApp({ route: '/new' });
    await screen.findByRole('heading', { name: 'What are we building?' });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    openPanel();
    expect(await within(panel()).findByText('/home/you')).toBeTruthy();
    ctrlBracket();
    expect(screen.queryByRole('complementary', { name: 'Right panel' })).toBeNull();
  });

  it('lists the project chosen on the new chat screen', async () => {
    const seed = await seededClient();
    renderApp({ client: seed.client, route: `/new?project=${seed.project.id}` });
    await screen.findByRole('heading', { name: 'What are we building?' });
    openPanel();
    expect(await within(panel()).findByText(seed.project.name)).toBeTruthy();
    expect(within(panel()).getByRole('navigation', { name: 'Project files' })).toBeTruthy();
  });
});

describe('stale file state', () => {
  const nav = (name: string) => within(panel()).getByRole('navigation', { name });

  async function switchChip(label: string) {
    openMenu(screen.getByRole('button', { name: /^Project:/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: label }));
  }

  async function dirty(
    seed: Awaited<ReturnType<typeof seededClient>>,
    route: string,
    files: 'Project files' | 'Home files',
  ) {
    renderApp({ client: seed.client, route });
    await screen.findByRole('heading', { name: 'What are we building?' });
    openPanel();
    await within(panel()).findByRole('navigation', { name: files });
    fireEvent.click(await within(panel()).findByRole('button', { name: /^README\.md/ }));
    expect(await within(panel()).findByRole('tab', { name: 'README.md', selected: true })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('tab', { name: 'Files' }));
    fireEvent.click(within(nav(files)).getByRole('button', { name: /^src$/ }));
    fireEvent.change(within(panel()).getByRole('searchbox', { name: 'Filter files' }), { target: { value: 'tools' } });
    return seed;
  }

  function expectClean() {
    expect(within(panel()).queryByRole('tab', { name: 'README.md' })).toBeNull();
    expect(within(panel()).getByRole('tab', { name: 'Files', selected: true })).toBeTruthy();
    expect((within(panel()).getByRole('searchbox', { name: 'Filter files' }) as HTMLInputElement).value).toBe('');
  }

  it('switching the chip to "No project" resets the panel and lists home', async () => {
    const seed = await seededClient();
    await dirty(seed, `/new?project=${seed.project.id}`, 'Project files');
    await switchChip('No project');
    await within(panel()).findByRole('navigation', { name: 'Home files' });
    expectClean();
    expect(
      (await within(nav('Home files')).findByRole('button', { name: /^src$/ })).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('switching to another project resets the panel', async () => {
    const seed = await seededClient();
    const other = seed.projects.find((p) => p.id !== seed.project.id);
    if (!other) throw new Error('seed needs a second project');
    await dirty(seed, `/new?project=${seed.project.id}`, 'Project files');
    await switchChip(other.name);
    await waitFor(() => expectClean());
    expect(
      (await within(nav('Project files')).findByRole('button', { name: /^src$/ })).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('a chat moved out of its project does not resolve old file tabs against home', async () => {
    const seed = await seededClient();
    const chat = await seed.client.createChat({ projectId: null, model: 'm' });
    const read = vi.spyOn(seed.client, 'readHomeFile');
    usePanelStore.setState({
      chats: {
        [chat.id]: {
          root: 'project:x',
          tabs: [{ type: 'file', path: 'src/index.ts' }],
          active: { type: 'file', path: 'src/index.ts' },
          params: {},
          expanded: {},
          query: '',
        },
      },
    });
    renderApp({ client: seed.client, route: `/chat/${chat.id}` });
    await screen.findByRole('heading', { level: 1, name: chat.title });
    openPanel();
    await within(panel()).findByRole('navigation', { name: 'Home files' });
    expect(within(panel()).queryByRole('tab', { name: 'index.ts' })).toBeNull();
    expect(within(panel()).getByRole('tab', { name: 'Files', selected: true })).toBeTruthy();
    expect(read).not.toHaveBeenCalledWith('src/index.ts');
    expect(usePanelStore.getState().chats[chat.id]?.root).toBe('home');
  });
});

describe('panel width', () => {
  const previousWidth = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: previousWidth });
  });

  it('keeps the same width when a file opens, and remembers a drag', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1800 });
    await renderChat();
    openPanel();
    const aside = panel() as HTMLElement;
    expect(aside.style.width).toBe(`${LAYOUT.panelFiles}px`);

    await within(panel()).findByRole('navigation', { name: 'Project files' });
    fireEvent.click(await within(panel()).findByRole('button', { name: 'README.md' }));
    await within(panel()).findByRole('tab', { name: 'README.md', selected: true });
    expect(aside.style.width).toBe(`${LAYOUT.panelFiles}px`);

    const handle = within(panel()).getByRole('separator', { name: 'Resize right panel' });
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 });
    expect(aside.style.width).toBe(`${LAYOUT.panelFiles + 100}px`);
    expect(window.localStorage.getItem(STORAGE_KEYS.rightPanelWidth)).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(aside.style.width).toBe(`${LAYOUT.panelFiles + 100}px`);
    expect(window.localStorage.getItem(STORAGE_KEYS.rightPanelWidth)).toBe(String(LAYOUT.panelFiles + 100));
    expect(readPersistedUi().rightPanelWidth).toBe(LAYOUT.panelFiles + 100);

    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(aside.style.width).toBe(`${LAYOUT.panelFiles + 100 - 16}px`);
  });
});
