import { AppProviders } from '@renderer/app/App';
import { renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { MockApiClient } from '@renderer/lib/mock-api-client';
import { queryKeys } from '@renderer/lib/query-keys';
import { createRun, useRunsStore } from '@renderer/stores/runs';
import { NEW_CHAT_TITLE } from '@shared/constants';
import type { ChatSummary, ChatUsage, ModelInfo } from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ContextUsageButton } from './ContextUsageButton';

const MODEL_ID = 'anthropic/claude-sonnet-5.5';
const SONNET_256K: ModelInfo = {
  id: MODEL_ID,
  name: 'Anthropic: Claude Sonnet 5.5',
  contextLength: 256_000,
  supportsTools: true,
  supportsImages: false,
  promptPricePerMTok: null,
  completionPricePerMTok: null,
};
const UNLIMITED: ModelInfo = {
  ...SONNET_256K,
  id: 'openrouter/auto',
  name: 'OpenRouter: Auto Router',
  contextLength: null,
};

// Local times, so the expected dates do not depend on the runner's time zone.
const CREATED = new Date(2026, 10, 5, 14, 14);
const LAST_ACTIVITY = new Date(2026, 10, 5, 15, 2);

function chatWith(usage: Partial<ChatUsage> = {}, model = MODEL_ID): ChatSummary {
  return {
    id: 'chat-1',
    projectId: null,
    title: 'Usage chat',
    model,
    createdAt: CREATED.toISOString(),
    updatedAt: LAST_ACTIVITY.toISOString(),
    archived: false,
    usage: { contextTokens: 0, promptTokens: 0, completionTokens: 0, costUsd: null, requests: 1, ...usage },
  };
}

/** Renders the counter with the models cache already filled, so the limit is there on the first paint. */
function renderCounter(chat: ChatSummary, models: ModelInfo[] = [SONNET_256K]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(queryKeys.models, models);
  const client = new MockApiClient({ delayMs: 0 });
  const view = render(
    <AppProviders client={client} queryClient={queryClient}>
      <ContextUsageButton chat={chat} />
    </AppProviders>,
  );
  const rerenderCounter = (next: ChatSummary) =>
    view.rerender(
      <AppProviders client={client} queryClient={queryClient}>
        <ContextUsageButton chat={next} />
      </AppProviders>,
    );
  return { ...view, rerenderCounter };
}

const counter = () => screen.getByRole('button', { name: /Context used/ });

async function openPopover(): Promise<HTMLElement> {
  fireEvent.click(counter());
  return screen.findByRole('dialog', { name: 'Context' });
}

/** The value under a label in the popover's `dl` (the `dd` after the `dt`). */
function field(dialog: HTMLElement, label: string): string | null {
  const dt = within(dialog).getByText(label, { selector: 'dt' });
  // Node's ICU puts a narrow no-break space (U+202F) before AM/PM; compare with a plain space.
  return dt.nextElementSibling?.textContent?.replace(/ /g, ' ') ?? null;
}

beforeEach(() => {
  resetUi();
  useRunsStore.setState({ runs: {}, chatModels: {} });
});

describe('ContextUsageButton', () => {
  it('renders nothing while the chat has no finished request', () => {
    const { container } = renderCounter(chatWith({ requests: 0 }));
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('button', { name: /Context used/ })).toBeNull();
  });

  it('shows the used figure and the limit, with the counter attributes', () => {
    renderCounter(chatWith({ contextTokens: 97_280 }));
    const button = counter();
    expect(within(button).getByText('97.3k')).toBeTruthy();
    expect(within(button).getByText('/ 256k')).toBeTruthy();
    expect(button.getAttribute('title')).toBe('Context used in this chat');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it.each([
    ['ok', 204_544], // 79.9%
    ['high', 204_800], // 80%
    ['full', 243_200], // 95%
  ] as const)('is at level %s when the context is at the given tokens', (level, contextTokens) => {
    renderCounter(chatWith({ contextTokens }));
    expect(counter().getAttribute('data-level')).toBe(level);
  });

  it('clicking opens a dialog named "Context"; Esc closes it and returns focus to the counter', async () => {
    renderCounter(chatWith({ contextTokens: 97_280 }));
    const trigger = counter();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Context' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('an outside click closes the popover', async () => {
    renderCounter(chatWith({ contextTokens: 97_280 }));
    await openPopover();
    // Radix attaches its document pointerdown listener on a timer and dismisses deferred pointer events on click.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      fireEvent.pointerDown(document.body);
      fireEvent.click(document.body);
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it.each(['running', 'settling'] as const)(
    'shows the usage captured before the run while it is %s, then the new summary',
    async (status) => {
      const before = chatWith({ contextTokens: 10_000, promptTokens: 10_000, completionTokens: 0, requests: 1 });
      const during = chatWith({ contextTokens: 97_280, promptTokens: 150_000, completionTokens: 5_000, requests: 4 });
      const { rerenderCounter } = renderCounter(before);
      expect(within(counter()).getByText('10k')).toBeTruthy();

      act(() => useRunsStore.setState({ runs: { [before.id]: { ...createRun(1), status } }, chatModels: {} }));
      rerenderCounter(during);
      expect(within(counter()).getByText('10k')).toBeTruthy();
      expect(within(counter()).queryByText('97.3k')).toBeNull();
      const dialog = await openPopover();
      expect(field(dialog, 'Total tokens used')).toBe('10,000');

      act(() => useRunsStore.setState({ runs: {}, chatModels: {} }));
      rerenderCounter(during);
      expect(within(counter()).getByText('97.3k')).toBeTruthy();
      expect(field(dialog, 'Total tokens used')).toBe('155,000');
    },
  );

  it('keeps the pre-run usage across a remount during the run', () => {
    const before = chatWith({ contextTokens: 10_000, promptTokens: 10_000, completionTokens: 0, requests: 1 });
    const during = chatWith({ contextTokens: 97_280, promptTokens: 150_000, completionTokens: 5_000, requests: 4 });
    const first = renderCounter(before);
    first.unmount();

    act(() => useRunsStore.setState({ runs: { [before.id]: createRun(1) }, chatModels: {} }));
    renderCounter(during);
    expect(within(counter()).getByText('10k')).toBeTruthy();
    expect(within(counter()).queryByText('97.3k')).toBeNull();
  });

  it('stays hidden through a new chat’s first reply', () => {
    const empty = chatWith({ contextTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0 });
    const firstReply = chatWith({
      contextTokens: 1_000,
      promptTokens: 1_000,
      completionTokens: 0,
      requests: 1,
    });
    const { rerenderCounter } = renderCounter(empty);
    expect(screen.queryByRole('button', { name: /Context used/ })).toBeNull();

    act(() => useRunsStore.setState({ runs: { [empty.id]: createRun(1) }, chatModels: {} }));
    rerenderCounter(firstReply);
    expect(screen.queryByRole('button', { name: /Context used/ })).toBeNull();

    act(() => useRunsStore.setState({ runs: {}, chatModels: {} }));
    rerenderCounter(firstReply);
    expect(counter()).toBeTruthy();
  });
});

describe('Context popover', () => {
  it('shows the percentage, the used figure with its limit, and the exact counts in the tooltip', async () => {
    renderCounter(chatWith({ contextTokens: 97_280, promptTokens: 96_000, completionTokens: 1_280, costUsd: 0.64 }));
    const dialog = await openPopover();
    expect(within(dialog).getByText('38%')).toBeTruthy();
    expect(within(dialog).getByText('97.3k')).toBeTruthy();
    expect(within(dialog).getByText('/ 256k')).toBeTruthy();
    expect(within(dialog).getByTitle('97,280 / 256,000 tokens')).toBeTruthy();
  });

  it.each([
    [97_280, '38', '38%'],
    [243_200, '95', '95%'],
  ])(
    'the progressbar reports the rounded percentage (%s tokens → aria-valuenow %s)',
    async (contextTokens, now, text) => {
      renderCounter(chatWith({ contextTokens, costUsd: 0.64 }));
      const dialog = await openPopover();
      const bar = within(dialog).getByRole('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBe(now);
      expect(bar.getAttribute('aria-valuetext')).toBe(text);
    },
  );

  it('rounds aria-valuenow while the visible percentage floors (79.6% → 80 vs 79%)', async () => {
    renderCounter(chatWith({ contextTokens: 203_776 }));
    const dialog = await openPopover();
    expect(within(dialog).getByText('79%')).toBeTruthy();
    const bar = within(dialog).getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('80');
    expect(bar.getAttribute('aria-valuetext')).toBe('79%');
  });

  it('clamps aria-valuenow to 100 when the used figure exceeds the limit', async () => {
    renderCounter(chatWith({ contextTokens: 300_000 }));
    const dialog = await openPopover();
    expect(within(dialog).getByText('117%')).toBeTruthy();
    expect(within(dialog).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('an unknown limit reads — and used, shows the note, and omits aria-valuenow', async () => {
    renderCounter(chatWith({ contextTokens: 97_280, costUsd: 0.64 }, 'openrouter/auto'), [UNLIMITED]);
    const dialog = await openPopover();
    expect(counter().textContent).toContain('/ —');
    expect(within(dialog).getByText('—')).toBeTruthy();
    expect(within(dialog).getByText('used')).toBeTruthy();
    expect(within(dialog).getByText("This model doesn't report a context limit.")).toBeTruthy();
    const bar = within(dialog).getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.getAttribute('aria-valuetext')).toBe('—');
    expect(within(dialog).getByTitle('97,280 tokens')).toBeTruthy();
  });

  it('says the limit is unavailable when the model is missing, not that it reports none', async () => {
    renderCounter(chatWith({ contextTokens: 97_280, costUsd: 0.64 }), []);
    const dialog = await openPopover();
    expect(counter().textContent).toContain('/ —');
    expect(within(dialog).getByText('Context limit unavailable.')).toBeTruthy();
    expect(within(dialog).queryByText(/doesn't report a context limit/)).toBeNull();
    expect(within(dialog).getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
  });

  it('does not show the unknown-limit note when the limit is known', async () => {
    renderCounter(chatWith({ contextTokens: 97_280, costUsd: 0.64 }));
    const dialog = await openPopover();
    expect(within(dialog).queryByText(/doesn't report a context limit/)).toBeNull();
  });

  it('lists Provider, Model, Total cost, Total tokens used, Created and Last activity', async () => {
    renderCounter(chatWith({ contextTokens: 97_280, promptTokens: 96_000, completionTokens: 1_280, costUsd: 0.64 }));
    const dialog = await openPopover();
    expect(field(dialog, 'Provider')).toBe('OpenRouter');
    expect(field(dialog, 'Model')).toBe('Claude Sonnet 5.5');
    expect(field(dialog, 'Total cost')).toBe('$0.64');
    expect(field(dialog, 'Total tokens used')).toBe('97,280');
    expect(field(dialog, 'Created')).toBe('Nov 5, 2026, 2:14 PM');
    expect(field(dialog, 'Last activity')).toBe('Nov 5, 2026, 3:02 PM');
  });

  it('Total cost reads — while no request has reported a cost', async () => {
    renderCounter(chatWith({ contextTokens: 1_000, promptTokens: 900, completionTokens: 100, costUsd: null }));
    const dialog = await openPopover();
    expect(field(dialog, 'Total cost')).toBe('—');
    expect(field(dialog, 'Total tokens used')).toBe('1,000');
  });

  it('Total cost reads <$0.01 for a tiny reported cost', async () => {
    renderCounter(chatWith({ contextTokens: 12_400, promptTokens: 12_000, completionTokens: 400, costUsd: 0.00006 }));
    const dialog = await openPopover();
    expect(field(dialog, 'Total cost')).toBe('<$0.01');
  });
});

describe('ChatHeader shows the counter', () => {
  it('after a finished reply: shows used / limit for the seeded chat', async () => {
    const seed = await seededClient();
    const chat = (await seed.client.listChats()).find((c) => c.title === 'Streaming replies over SSE');
    if (!chat) throw new Error('seed missing');
    renderApp({ client: seed.client, route: `/chat/${chat.id}` });
    await screen.findByRole('heading', { level: 1, name: chat.title });
    // Models load asynchronously, so wait for the limit to appear next to the used figure.
    await waitFor(() => expect(counter().textContent).toContain('/ 1M'));
    expect(within(counter()).getByText('860k')).toBeTruthy();
  });

  it('a new chat has no counter', async () => {
    const seed = await seededClient();
    const chat = await seed.client.createChat({ projectId: null, model: MODEL_ID });
    renderApp({ client: seed.client, route: `/chat/${chat.id}` });
    await screen.findByRole('heading', { level: 1, name: NEW_CHAT_TITLE });
    expect(screen.queryByRole('button', { name: /Context used/ })).toBeNull();
  });
});
