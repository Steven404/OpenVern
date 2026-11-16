import { renderApp, resetUi, seededClient } from '@renderer/app/test-utils';
import { ApiError } from '@renderer/lib/api-client';
import { makeFileChange, makeHunk, sampleProposal } from '@renderer/lib/mock-changes';
import { queryKeys } from '@renderer/lib/query-keys';
import { createRun, useRunsStore } from '@renderer/stores/runs';
import { readPersistedUi, STORAGE_KEYS, useUiStore } from '@renderer/stores/ui';
import { LAYOUT } from '@shared/constants';
import { errorInfo } from '@shared/errors';
import type { AppliedBatch, PendingChanges } from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanelStore } from '../right-panel/panel-store';
import {
  allRejected,
  appliedLabel,
  buildDecisions,
  fileState,
  footerHint,
  pairLines,
  parseHunk,
  progressLabel,
  progressOf,
} from './diff';
import { AppliedEditsCard, ProposedEditsCard } from './ProposedEditsCard';
import { effectiveDecisions, useReviewStore } from './review-store';

beforeEach(() => {
  resetUi();
  usePanelStore.setState({ chats: {} });
  useReviewStore.setState({ chats: {} });
  useRunsStore.setState({ runs: {} });
  window.innerWidth = 1600;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pendingOf = (revision = 1): PendingChanges => {
  const files = sampleProposal();
  return {
    revision,
    messageId: 'm1',
    files,
    totalAdd: files.reduce((n, f) => n + f.add, 0),
    totalDel: files.reduce((n, f) => n + f.del, 0),
  };
};

describe('diff helpers', () => {
  it('numbers lines and pairs deletions with additions', () => {
    const h = makeHunk(10, 12, '', [' a', '-b', '-c', '+B', '+C', '+D', ' e']);
    const lines = parseHunk(h);
    expect(lines.map((l) => [l.o, l.n])).toEqual([
      [10, 12],
      [11, null],
      [12, null],
      [null, 13],
      [null, 14],
      [null, 15],
      [13, 16],
    ]);
    const rows = pairLines(lines);
    expect(rows).toHaveLength(5);
    expect(rows[3]?.left).toBeNull();
    expect(rows[3]?.right?.code).toBe('D');
    expect(rows[0]?.left).toBe(rows[0]?.right);
  });

  it('labels progress, hints and file state', () => {
    const p = pendingOf();
    const [create, index] = p.files as [(typeof p.files)[0], (typeof p.files)[0]];
    expect(progressLabel(progressOf(p.files, {}))).toBe('0 of 4 changes reviewed');
    expect(footerHint(progressOf(p.files, {}))).toBe('Undecided changes are left out when you apply.');

    const all = (d: 'accepted' | 'rejected') =>
      Object.fromEntries(p.files.map((f) => [f.path, Object.fromEntries(f.hunks.map((h) => [h.id, d]))]));
    expect(progressLabel(progressOf(p.files, all('accepted')))).toBe('All 4 changes reviewed');
    expect(footerHint(progressOf(p.files, all('accepted')))).toBe('Ready to write to disk.');
    expect(footerHint(progressOf(p.files, all('rejected')))).toBe('4 rejected changes will be dropped.');
    expect(allRejected(progressOf(p.files, all('rejected')))).toBe(true);

    const first = index.hunks[0]?.id as string;
    expect(fileState(index, { [first]: 'accepted' })).toEqual({ label: '1 of 2', tone: 'neutral' });
    expect(fileState(index, { [first]: 'accepted', [index.hunks[1]?.id as string]: 'rejected' }).label).toBe(
      'Partly accepted',
    );
    expect(fileState(create, { [create.hunks[0]?.id as string]: 'rejected' })).toEqual({
      label: 'Rejected',
      tone: 'bad',
    });
  });

  it('describes an applied batch', () => {
    const files = sampleProposal();
    expect(
      appliedLabel({
        id: 'b',
        appliedAt: '2026-01-01T00:00:00.000Z',
        messageId: 'm1',
        written: files,
        rejectedHunks: 1,
        skippedHunks: 0,
        conflicts: [],
      }),
    ).toBe('Wrote 4 changes to 3 files · 1 rejected');
  });
});

describe('decisions store', () => {
  it('keeps decisions for hunk ids that still exist when the revision changes', () => {
    const rev1 = pendingOf(1);
    const store = useReviewStore.getState();
    const [create, index] = rev1.files as [(typeof rev1.files)[0], (typeof rev1.files)[0]];
    store.decide('c', rev1, create.path, create.hunks[0]?.id as string, 'accepted');
    store.decide('c', rev1, index.path, index.hunks[1]?.id as string, 'rejected');

    // Revision 2: the index.ts second hunk changed (new id), the rest is the same.
    const changed = makeFileChange(index.path, 'modify', [
      index.hunks[0] as (typeof index.hunks)[0],
      makeHunk(21, 22, '', [' x', '-y', '+z']),
    ]);
    const rev2: PendingChanges = { ...rev1, revision: 2, files: [create, changed] };
    const eff = effectiveDecisions(useReviewStore.getState().chats.c, rev2);
    expect(eff[create.path]).toEqual({ [create.hunks[0]?.id as string]: 'accepted' });
    expect(eff[index.path]).toBeUndefined();
    expect(buildDecisions(rev2.files, eff)).toEqual(eff);
  });

  it('Accept all / Reject all / Undo', () => {
    const p = pendingOf();
    const s = useReviewStore.getState();
    s.setAll('c', p, 'accepted');
    expect(progressOf(p.files, effectiveDecisions(useReviewStore.getState().chats.c, p)).accepted).toBe(4);
    s.setAll('c', p, 'rejected');
    expect(progressOf(p.files, effectiveDecisions(useReviewStore.getState().chats.c, p)).rejected).toBe(4);
    const f = p.files[0] as (typeof p.files)[0];
    s.decide('c', p, f.path, f.hunks[0]?.id as string, null);
    expect(progressOf(p.files, effectiveDecisions(useReviewStore.getState().chats.c, p)).rejected).toBe(3);
  });
});

async function stagedChat() {
  const seed = await seededClient();
  const { client, chat } = seed;
  for await (const _ev of client.sendMessage(
    chat.id,
    { text: '[mock:edit]', attachmentIds: [], model: chat.model },
    new AbortController().signal,
  )) {
    // drain: stages the sample proposal and persists the turn
  }
  return seed;
}

async function renderStaged() {
  const seed = await stagedChat();
  renderApp({ client: seed.client, route: `/chat/${seed.chat.id}` });
  await screen.findByRole('heading', { level: 1, name: seed.chat.title });
  return seed;
}

const panel = () => screen.getByRole('complementary', { name: 'Right panel' });
const card = async () => screen.findByTestId('changes-card');

async function openReview() {
  const seed = await renderStaged();
  fireEvent.click(within(await card()).getByRole('button', { name: /Review changes/ }));
  const p = await waitFor(() => panel());
  await within(p).findByRole('button', { name: 'Apply' });
  return { ...seed, p };
}

describe('proposed edits card', () => {
  it('sits under the turn of PendingChanges.messageId and lists the files', async () => {
    const { client, chat } = await renderStaged();
    const el = await card();
    expect(within(el).getByText('Proposed edits')).toBeTruthy();
    expect(within(el).getByText('3 files')).toBeTruthy();
    expect(within(el).getByText('0 of 4 changes reviewed')).toBeTruthy();
    expect(within(el).getByText('Nothing is written until you apply.')).toBeTruthy();
    const turn = el.closest('[data-testid="assistant-turn"]');
    expect(turn).toBeTruthy();
    const pending = (await client.getChatChanges(chat.id)).pending;
    expect(pending?.messageId).toBeTruthy();
    expect(screen.getAllByTestId('changes-card')).toHaveLength(1);
  });

  it('opens the pane on the clicked file', async () => {
    await renderStaged();
    const el = await card();
    fireEvent.click(within(el).getByRole('button', { name: /constants\.ts/ }));
    const p = await waitFor(() => panel());
    expect(within(p).getByRole('region', { name: 'Review changes' })).toBeTruthy();
    expect(
      within(p)
        .getByRole('button', { name: /constants\.ts/ })
        .getAttribute('aria-current'),
    ).toBe('true');
    expect(within(p).getByText('1 change')).toBeTruthy();
    expect(within(el).getByRole('button', { name: /Reviewing/ })).toBeTruthy();
  });
});

describe('review pane', () => {
  it('sizes the file list from a keyboard handle, saved globally', async () => {
    const { p } = await openReview();
    const handle = within(p).getByRole('separator', { name: 'Resize file list' });
    expect(handle.getAttribute('aria-valuenow')).toBe('35');
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(handle.getAttribute('aria-valuenow')).toBe('37');
    expect(window.localStorage.getItem(STORAGE_KEYS.diffListRatio)).toBe('0.37');
    fireEvent.keyDown(handle, { key: 'ArrowUp', shiftKey: true });
    expect(handle.getAttribute('aria-valuenow')).toBe('27');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle.getAttribute('aria-valuemax')).toBe('80');
    expect(handle.getAttribute('aria-valuenow')).toBe('80');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle.getAttribute('aria-valuemin')).toBe('10');
    expect(handle.getAttribute('aria-valuenow')).toBe('10');
  });

  it('resets the file list height on double-click', async () => {
    const { p } = await openReview();
    const handle = within(p).getByRole('separator', { name: 'Resize file list' });
    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute('aria-valuenow')).toBe('35');
    expect(window.localStorage.getItem(STORAGE_KEYS.diffListRatio)).toBe('0.35');
  });

  it('shows the stored file list height after a reload', async () => {
    const { p } = await openReview();
    const handle = within(p).getByRole('separator', { name: 'Resize file list' });
    window.localStorage.setItem(STORAGE_KEYS.diffListRatio, '0.5');
    act(() => useUiStore.setState(readPersistedUi()));
    expect(handle.getAttribute('aria-valuenow')).toBe('50');
  });

  it('decides hunks, shows labels and applies the accepted ones', async () => {
    const { client, chat, p } = await openReview();
    const spy = vi.spyOn(client, 'applyChatChanges');

    expect((within(p).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(p).getByRole('button', { name: 'Accept all' }));
    expect(within(p).getByText('All 4 changes reviewed')).toBeTruthy();
    expect(within(p).getByText('Ready to write to disk.')).toBeTruthy();
    expect(within(p).getAllByText('Accepted').length).toBeGreaterThan(0);

    // Undo and reject the single hunk of the first file (write-file.ts, selected by default).
    fireEvent.click(within(p).getByRole('button', { name: 'Undo decision' }));
    expect(within(p).getByText('3 of 4 changes reviewed')).toBeTruthy();
    fireEvent.click(within(p).getByRole('button', { name: 'Reject this change' }));
    expect(within(p).getByText('All 4 changes reviewed')).toBeTruthy();
    expect(within(p).getByText('1 rejected change will be dropped.')).toBeTruthy();

    fireEvent.click(within(p).getByRole('button', { name: 'Apply 3' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [, body] = spy.mock.calls[0] as [
      string,
      { revision: number; decisions: Record<string, Record<string, string>> },
    ];
    expect(Object.keys(body.decisions)).toHaveLength(3);
    expect(Object.values(body.decisions['src/core/tools/write-file.ts'] ?? {})).toEqual(['rejected']);
    expect(Object.values(body.decisions['src/core/tools/index.ts'] ?? {})).toEqual(['accepted', 'accepted']);

    const cardEl = await screen.findByText('Edits applied');
    const shell = cardEl.closest('[data-testid="changes-card"]') as HTMLElement;
    expect(within(shell).getByText('Wrote 3 changes to 2 files · 1 rejected')).toBeTruthy();
    expect((await client.getChatChanges(chat.id)).pending).toBeNull();
    // Applied batches stay listed, read-only, and Diff stays enabled.
    expect(await within(panel()).findByTestId('applied-batch')).toBeTruthy();
  });

  it('shows "Discard" when every change is rejected and clears the proposal', async () => {
    const { client, chat, p } = await openReview();
    const spy = vi.spyOn(client, 'discardChatChanges');
    fireEvent.click(within(p).getByRole('button', { name: 'Reject all' }));
    fireEvent.click(within(p).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(chat.id));
    await waitFor(() => expect(within(panel()).getByText('No edits are waiting for review.')).toBeTruthy());
  });

  it('refetches on changes_stale and keeps decisions for surviving hunk ids', async () => {
    const { client, chat, p } = await openReview();
    const current = await client.getChatChanges(chat.id);
    const pending = current.pending as PendingChanges;
    fireEvent.click(within(p).getByRole('button', { name: 'Accept all' }));

    const next: PendingChanges = {
      ...pending,
      revision: pending.revision + 1,
      files: pending.files.filter((f) => !f.path.endsWith('constants.ts')),
    };
    vi.spyOn(client, 'applyChatChanges').mockRejectedValue(new ApiError(errorInfo('changes_stale'), 409));
    const get = vi.spyOn(client, 'getChatChanges').mockResolvedValue({ pending: next, applied: [] });

    fireEvent.click(within(p).getByRole('button', { name: /Apply 4/ }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(
      await within(p).findByText('The proposed edits changed while you were reviewing. Review them again.'),
    ).toBeTruthy();
    // The constants.ts hunk is gone; the other three keep their decision.
    expect(await within(p).findByText('All 3 changes reviewed')).toBeTruthy();
    expect(within(p).getByRole('button', { name: 'Apply 3' })).toBeTruthy();
  });

  it('shows other apply errors inline', async () => {
    const { client, p } = await openReview();
    fireEvent.click(within(p).getByRole('button', { name: 'Accept all' }));
    vi.spyOn(client, 'applyChatChanges').mockRejectedValue(
      new ApiError(errorInfo('conflict', 'Wait for the reply to finish first.'), 409),
    );
    fireEvent.click(within(p).getByRole('button', { name: /Apply 4/ }));
    expect(await within(p).findByText('Wait for the reply to finish first.')).toBeTruthy();
  });

  it('disables Apply and Discard while the chat is streaming', async () => {
    const { chat, p } = await openReview();
    fireEvent.click(within(p).getByRole('button', { name: 'Accept all' }));
    expect((within(p).getByRole('button', { name: /Apply 4/ }) as HTMLButtonElement).disabled).toBe(false);
    useRunsStore.setState({ runs: { [chat.id]: createRun(1) } });
    await waitFor(() =>
      expect((within(p).getByRole('button', { name: /Apply 4/ }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(within(p).getByText('Wait for the reply to finish.')).toBeTruthy();
    fireEvent.click(within(p).getByRole('button', { name: 'Reject all' }));
    expect((within(p).getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(true);
  });

  const panelWidthNow = () => useUiStore.getState().rightPanelWidth;
  const splitBtn = (p: HTMLElement) => within(p).getByRole('button', { name: 'Split' }) as HTMLButtonElement;

  it('switches to the split layout when there is room, widening the panel', async () => {
    const { p } = await openReview();
    const split = splitBtn(p);
    expect(split.disabled).toBe(false);
    expect(panelWidthNow()).toBe(380);
    fireEvent.click(split);
    expect(panelWidthNow()).toBe(LAYOUT.panelDiffSplit);
    expect(p.style.width).toBe('800px');
    expect(split.getAttribute('aria-pressed')).toBe('true');
    expect(p.querySelector('[data-side="left"]')).toBeTruthy();
    expect(p.querySelector('[data-line="none"]')).toBeTruthy();
  });

  it('keeps an already wide panel as is when Split is picked', async () => {
    act(() => useUiStore.getState().setRightPanelWidth(700));
    const { p } = await openReview();
    fireEvent.click(splitBtn(p));
    expect(panelWidthNow()).toBe(700);
    expect(splitBtn(p).getAttribute('aria-pressed')).toBe('true');
    expect(p.querySelector('[data-side="left"]')).toBeTruthy();
  });

  it('widens only as far as the window allows', async () => {
    window.innerWidth = 1400;
    const { p } = await openReview();
    fireEvent.click(splitBtn(p));
    expect(panelWidthNow()).toBe(708);
    expect(p.querySelector('[data-side="left"]')).toBeTruthy();
  });

  it('falls back to unified when the panel is narrowed, and Split widens it again', async () => {
    const { p } = await openReview();
    fireEvent.click(splitBtn(p));
    act(() => useUiStore.getState().setRightPanelWidth(500));
    expect(splitBtn(p).getAttribute('aria-pressed')).toBe('false');
    expect(within(p).getByRole('button', { name: 'Unified' }).getAttribute('aria-pressed')).toBe('true');
    expect(p.querySelector('[data-side="left"]')).toBeNull();
    expect(splitBtn(p).disabled).toBe(false);
    fireEvent.click(splitBtn(p));
    expect(panelWidthNow()).toBe(LAYOUT.panelDiffSplit);
    expect(p.querySelector('[data-side="left"]')).toBeTruthy();
  });

  it('disables Split on a narrow window', async () => {
    window.innerWidth = 1100;
    const { p } = await openReview();
    const split = splitBtn(p);
    expect(split.disabled).toBe(true);
    expect(split.title).toBe('Make the window wider to use Split');
    fireEvent.click(split);
    expect(panelWidthNow()).toBe(380);
  });

  it('enables Split on a narrow window when the sidebar is collapsed', async () => {
    window.innerWidth = 1100;
    useUiStore.setState({ sidebarCollapsed: true });
    const { p } = await openReview();
    expect(splitBtn(p).disabled).toBe(false);
    fireEvent.click(splitBtn(p));
    expect(panelWidthNow()).toBe(680);
  });

  it('marks the placeholder for a file that is too large', async () => {
    const { client, chat } = await openReview();
    const current = (await client.getChatChanges(chat.id)).pending as PendingChanges;
    const big = { ...current.files[0], tooLarge: true, hunks: [] } as PendingChanges['files'][number];
    cleanup();
    vi.spyOn(client, 'getChatChanges').mockResolvedValue({
      pending: { ...current, files: [big, ...current.files.slice(1)] },
      applied: [],
    });
    renderApp({ client, route: `/chat/${chat.id}` });
    // The panel is still open on the Diff tab.
    expect(await screen.findByText(/too large to show here/)).toBeTruthy();
  });
});

// jsdom has no layout. These stubs measure the review pane: the body is `bodyPx` tall, the file list is `navPx` tall
// (its natural height and its visible box), and each row is `ROW_PX` tall and moves with the list's scroll, so an
// off-screen row has a real position.
const ROW_PX = 36;
const LIST = 'nav[aria-label="Changed files"]';

interface Layout {
  bodyPx: number;
  navPx: number;
}

function stubLayout(layout: Layout): void {
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches(LIST)) return rect(0, layout.navPx);
    if (this.querySelector(`:scope > ${LIST}`)) return rect(0, layout.bodyPx);
    const nav = this.closest(LIST);
    const item = this.closest('li');
    if (!nav || !item) return rect(0, 0);
    const index = Array.from(nav.querySelectorAll('li')).indexOf(item);
    return rect(index * ROW_PX - (nav as HTMLElement).scrollTop, ROW_PX);
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.matches(LIST) ? layout.navPx : 0;
  });
}

describe('measured file list', () => {
  let layout: Layout;
  beforeEach(() => {
    layout = { bodyPx: 500, navPx: 175 };
    stubLayout(layout);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  async function openMeasured() {
    const { p } = await openReview();
    return {
      handle: within(p).getByRole('separator', { name: 'Resize file list' }),
      nav: within(p).getByRole('navigation', { name: 'Changed files' }),
    };
  }
  const fileRow = (nav: HTMLElement, index: number): HTMLElement => {
    const row = within(nav).getAllByRole('button')[index];
    if (!row) throw new Error(`no file row ${index}`);
    return row;
  };
  const listWrites = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([key]) => key === STORAGE_KEYS.diffListRatio);

  it('shows the stored ratio clamped to a small body, and keeps the stored preference', async () => {
    layout.bodyPx = 400;
    layout.navPx = 234;
    useUiStore.setState({ diffListRatio: 0.8 });
    const { handle, nav } = await openMeasured();
    const now = Number(handle.getAttribute('aria-valuenow'));
    expect(now).toBeGreaterThanOrEqual(Number(handle.getAttribute('aria-valuemin')));
    expect(now).toBeLessThanOrEqual(Number(handle.getAttribute('aria-valuemax')));
    expect(nav.style.maxHeight).toBe('234px');
    expect(useUiStore.getState().diffListRatio).toBe(0.8);
    expect(window.localStorage.getItem(STORAGE_KEYS.diffListRatio)).toBeNull();
  });

  it('steps from the clamped ratio, not from the stored one', async () => {
    layout.bodyPx = 400;
    layout.navPx = 234;
    useUiStore.setState({ diffListRatio: 0.8 });
    const { handle } = await openMeasured();
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(Number(window.localStorage.getItem(STORAGE_KEYS.diffListRatio))).toBeCloseTo(0.565);
  });

  it('jumps Home and End to the measured limits', async () => {
    const { handle } = await openMeasured();
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle.getAttribute('aria-valuemax')).toBe('67');
    expect(handle.getAttribute('aria-valuenow')).toBe('67');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle.getAttribute('aria-valuemin')).toBe('19');
    expect(handle.getAttribute('aria-valuenow')).toBe('19');
  });

  it('drags the ceiling and writes storage once, on release', async () => {
    const { handle, nav } = await openMeasured();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent.pointerDown(handle, { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 130 });
    fireEvent.pointerMove(window, { clientY: 160 });
    // From the 175px ceiling, down 60px: 235px of 500px.
    expect(handle.getAttribute('aria-valuenow')).toBe('47');
    expect(nav.style.maxHeight).toBe('235px');
    expect(listWrites(setItem)).toHaveLength(0);
    fireEvent.pointerUp(window, { clientY: 160 });
    expect(listWrites(setItem)).toEqual([[STORAGE_KEYS.diffListRatio, '0.47']]);
    expect(window.localStorage.getItem(STORAGE_KEYS.diffListRatio)).toBe('0.47');
  });

  it('ends a drag on pointercancel the same way as on pointerup', async () => {
    const { handle } = await openMeasured();
    fireEvent.pointerDown(handle, { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 130 });
    fireEvent.pointerCancel(window, { clientY: 130 });
    expect(window.localStorage.getItem(STORAGE_KEYS.diffListRatio)).toBe('0.41');
    fireEvent.pointerMove(window, { clientY: 300 });
    expect(handle.getAttribute('aria-valuenow')).toBe('41');
  });

  it('leaves the ratio alone for a click or a 1px jiggle on the handle', async () => {
    const { handle } = await openMeasured();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent.pointerDown(handle, { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 101 });
    fireEvent.pointerUp(window, { clientY: 101 });
    fireEvent.pointerDown(handle, { button: 0, clientY: 100 });
    fireEvent.pointerUp(window, { clientY: 100 });
    expect(handle.getAttribute('aria-valuenow')).toBe('35');
    expect(useUiStore.getState().diffListRatio).toBe(0.35);
    expect(listWrites(setItem)).toHaveLength(0);
  });

  it('does not lower the ceiling when a drag starts on a short list', async () => {
    // Three rows, 100px of list under a 175px ceiling.
    layout.navPx = 100;
    const { handle } = await openMeasured();
    fireEvent.pointerDown(handle, { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 103 });
    fireEvent.pointerUp(window, { clientY: 103 });
    // (175 + 3) / 500, not (100 + 3) / 500.
    expect(handle.getAttribute('aria-valuenow')).toBe('36');
    expect(window.localStorage.getItem(STORAGE_KEYS.diffListRatio)).toBe('0.356');
  });

  it('restores the body cursor and text selection when it unmounts mid-drag', async () => {
    document.body.style.cursor = 'help';
    document.body.style.userSelect = 'text';
    const { handle } = await openMeasured();
    fireEvent.pointerDown(handle, { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 130 });
    expect(document.body.style.cursor).toBe('row-resize');
    expect(document.body.style.userSelect).toBe('none');
    cleanup();
    expect(document.body.style.cursor).toBe('help');
    expect(document.body.style.userSelect).toBe('text');
  });

  it('scrolls only the file list to bring an off-screen current row into view', async () => {
    // The list shows 60px: row 0 is 0–36, row 1 is 36–72, row 2 is 72–108.
    layout.navPx = 60;
    const { nav } = await openMeasured();
    const original = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const third = fileRow(nav, 2);
      fireEvent.click(third);
      expect(third.getAttribute('aria-current')).toBe('true');
      expect(nav.scrollTop).toBe(48);
      fireEvent.click(fileRow(nav, 0));
      expect(nav.scrollTop).toBe(0);
      fireEvent.click(fileRow(nav, 1));
      expect(nav.scrollTop).toBe(12);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('does not scroll the list for a row that is already visible', async () => {
    layout.navPx = 120;
    const { nav } = await openMeasured();
    fireEvent.click(fileRow(nav, 2));
    expect(nav.scrollTop).toBe(0);
  });
});

describe('long file lists in the cards', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => makeFileChange(`src/gen/file-${i}.ts`, 'modify', [makeHunk(1, 1, '', ['+x'])]));
  const pendingWith = (files: PendingChanges['files']): PendingChanges => ({
    revision: 1,
    messageId: 'm1',
    files,
    totalAdd: files.length,
    totalDel: 0,
  });
  const liCount = (el: HTMLElement) => within(el).getAllByRole('listitem').length;

  it('shows a preview of six files and expands to all of them', () => {
    const files = many(12);
    render(<ProposedEditsCard chatId="c" pending={pendingWith(files)} />);
    const el = screen.getByTestId('changes-card');
    expect(liCount(el)).toBe(6);
    const toggle = within(el).getByRole('button', { name: 'Show all 12 files' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(within(el).getByRole('list').id);

    fireEvent.click(toggle);
    expect(liCount(el)).toBe(12);
    const fewer = within(el).getByRole('button', { name: 'Show fewer' });
    expect(fewer.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fewer);
    expect(liCount(el)).toBe(6);
  });

  it('shows no toggle for a card with three files', () => {
    render(<ProposedEditsCard chatId="c" pending={pendingWith(sampleProposal())} />);
    const el = screen.getByTestId('changes-card');
    expect(liCount(el)).toBe(3);
    expect(within(el).queryByRole('button', { name: /^Show / })).toBeNull();
  });

  it('drops the toggle when an expanded card shrinks to five files', () => {
    const { rerender } = render(<ProposedEditsCard chatId="c" pending={pendingWith(many(12))} />);
    const el = screen.getByTestId('changes-card');
    fireEvent.click(within(el).getByRole('button', { name: 'Show all 12 files' }));
    expect(liCount(el)).toBe(12);

    rerender(<ProposedEditsCard chatId="c" pending={pendingWith(many(5))} />);
    expect(liCount(el)).toBe(5);
    expect(within(el).queryByRole('button', { name: /^Show / })).toBeNull();
  });

  it('collapses the applied-edits card the same way', () => {
    const files = many(12);
    const batch: AppliedBatch = {
      id: 'b1',
      appliedAt: '2026-01-01T00:00:00.000Z',
      messageId: 'm1',
      written: files,
      rejectedHunks: 0,
      skippedHunks: 0,
      conflicts: [],
    };
    render(<AppliedEditsCard chatId="c" batch={batch} />);
    const el = screen.getByTestId('changes-card');
    expect(liCount(el)).toBe(6);
    fireEvent.click(within(el).getByRole('button', { name: 'Show all 12 files' }));
    expect(liCount(el)).toBe(12);
    expect(within(el).getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('live updates', () => {
  it('changes_updated refreshes the chatChanges query during the run', async () => {
    const { client, chat } = await seededClient();
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.chatChanges(chat.id), { pending: null, applied: [] });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    await useRunsStore
      .getState()
      .send({ api: client, queryClient }, chat.id, { text: '[mock:edit]', attachments: [], model: chat.model });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.chatChanges(chat.id) });
    expect((await client.getChatChanges(chat.id)).pending?.files).toHaveLength(3);
  });
});
