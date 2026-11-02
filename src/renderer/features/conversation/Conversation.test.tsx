import { TREE_UNAVAILABLE_NOTICE } from '@shared/constants';
import { errorInfo } from '@shared/errors';
import type { AssistantMessage, Chat, Message, ToolMessage, UserMessage } from '@shared/types';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockApiClient } from '../../lib/mock-api-client';
import { createRun, PENDING_PREFIX, useRunsStore } from '../../stores/runs';
import { useUiStore } from '../../stores/ui';
import { formatDuration } from '../composer/format';
import { installDomStubs, renderWithProviders, resetStores } from '../composer/test-utils';
import { Conversation } from './Conversation';
import { findOpenFence, Markdown } from './Markdown';
import { ToolCallRow } from './ToolCallRow';
import { buildTurns, isWaiting, mergeMessages } from './turns';

beforeAll(installDomStubs);
beforeEach(resetStores);
afterEach(cleanup);

const T = '2026-01-01T00:00:00.000Z';
const user = (id: string, text: string): UserMessage => ({ id, role: 'user', createdAt: T, text, attachments: [] });
const assistant = (id: string, text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: T,
  model: 'anthropic/claude-sonnet-5.5',
  text,
  toolCalls: [],
  status: 'complete',
  ...extra,
});
const tool = (id: string, callId: string, extra: Partial<ToolMessage> = {}): ToolMessage => ({
  id,
  role: 'tool',
  createdAt: T,
  toolCallId: callId,
  name: 'read_file',
  ok: true,
  output: 'file body',
  summary: 'src/a.ts',
  durationMs: 200,
  ...extra,
});

async function seededChat() {
  const api = new MockApiClient({ delayMs: 0 });
  const chat = (await api.listChats())[0];
  if (!chat) throw new Error('no chat');
  return { api, chat };
}

describe('formatDuration', () => {
  it('formats 0.2s, 1.4s, 12s', () => {
    expect(formatDuration(200)).toBe('0.2s');
    expect(formatDuration(1400)).toBe('1.4s');
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(9_990)).toBe('10s');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });
});

describe('turn grouping', () => {
  it('groups each user message with one assistant turn, texts and tools in order', () => {
    const call1 = { id: 'c1', name: 'read_file', argsJson: '{}' };
    const messages: Message[] = [
      user('u1', 'q1'),
      assistant('a1', 'looking', { toolCalls: [call1] }),
      tool('t1', 'c1'),
      assistant('a2', 'answer 1'),
      user('u2', 'q2'),
      assistant('a3', 'answer 2'),
    ];
    const turns = buildTurns(messages, { active: false, streamingId: null, runningToolIds: [] });
    expect(turns).toHaveLength(2);
    expect(turns[0]?.blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
    expect(turns[1]?.blocks.map((b) => b.kind)).toEqual(['text']);
    const row = turns[0]?.blocks[1];
    expect(row?.kind === 'tool' && row.state).toBe('ok');
  });

  it('only the call with a tool_call event is running; the rest are queued', () => {
    const calls = ['c1', 'c2', 'c3'].map((id) => ({ id, name: 'read_file', argsJson: '{}' }));
    const base = [user('u1', 'q'), assistant('a1', '', { toolCalls: calls })];
    const states = (messages: Message[], active: boolean, ids: string[]) =>
      buildTurns(messages, { active, streamingId: null, runningToolIds: ids })[0]?.blocks.map((b) =>
        b.kind === 'tool' ? b.state : b.kind,
      );
    expect(states(base, true, ['c1'])).toEqual(['running', 'queued', 'queued']);
    expect(states([...base, tool('t1', 'c1')], true, ['c2'])).toEqual(['ok', 'running', 'queued']);
    expect(states(base, false, [])).toEqual(['skipped', 'skipped', 'skipped']);
    const turns = buildTurns(base, { active: true, streamingId: null, runningToolIds: [] });
    expect(isWaiting(turns, { ...createRun(1) })).toBe(false);
  });

  it('merges the run overlay without duplicating persisted messages', () => {
    const persisted = [user('u1', 'q'), assistant('a1', 'partial persisted')];
    const run = { ...createRun(1), messages: [user('u1', 'q'), assistant('a1', 'full text')] };
    const merged = mergeMessages(persisted, run);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(merged[1]).toMatchObject({ text: 'full text' });
  });

  it('renders one article per assistant turn with a single avatar header', async () => {
    const { api, chat } = await seededChat();
    renderWithProviders(<Conversation chatId={chat.id} />, { api });
    const turns = await screen.findAllByTestId('assistant-turn');
    expect(turns).toHaveLength(1);
    expect(screen.getAllByTestId('user-bubble')).toHaveLength(1);
    const turn = turns[0] as HTMLElement;
    expect(within(turn).getAllByTestId('tool-row')).toHaveLength(1);
    expect(within(turn).getAllByText('harness')).toHaveLength(1);
    expect(within(turn).getByText(/That shape is right/)).toBeTruthy();
    expect(within(turn).getByText(/Two guards are worth adding/)).toBeTruthy();
    // tool row sits between the two texts
    const html = turn.innerHTML;
    expect(html.indexOf('That shape is right')).toBeLessThan(html.indexOf('data-testid="tool-row"'));
    expect(html.indexOf('data-testid="tool-row"')).toBeLessThan(html.indexOf('Two guards'));
  });

  it('shows a persisted notice as a status line under the assistant turn', async () => {
    const { api, chat } = await seededChat();
    const full: Chat = {
      ...chat,
      messages: [user('u1', 'q'), assistant('a1', 'the answer', { notice: TREE_UNAVAILABLE_NOTICE })],
    };
    renderWithProviders(<Conversation chatId={chat.id} />, { api, chats: [full] });
    expect(await screen.findByText('the answer')).toBeTruthy();
    const notice = screen.getByRole('status');
    expect(notice.textContent).toBe(TREE_UNAVAILABLE_NOTICE);
  });

  it('shows "Stopped" on stopped messages and offers Retry on the last turn', async () => {
    const { api, chat } = await seededChat();
    const retry = vi.spyOn(api, 'retry');
    const full: Chat = {
      ...chat,
      messages: [user('u1', 'q'), assistant('a1', 'partial answer', { status: 'stopped' })],
    };
    renderWithProviders(<Conversation chatId={chat.id} />, { api, chats: [full] });
    expect(await screen.findByText('partial answer')).toBeTruthy();
    expect(screen.getByTestId('stopped-label').textContent).toBe('Stopped');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('ToolCallRow', () => {
  const call = { id: 'c1', name: 'read_file', argsJson: '{"path":"src/a.ts"}' };

  it('shows a spinner while running, using the args as summary', () => {
    renderWithProviders(<ToolCallRow block={{ call, state: 'running' }} />);
    expect(screen.getByTestId('spinner')).toBeTruthy();
    expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByTestId('tool-row').getAttribute('data-state')).toBe('running');
  });

  it('shows a muted queued icon without a spinner', () => {
    renderWithProviders(<ToolCallRow block={{ call, state: 'queued' }} />);
    expect(screen.queryByTestId('spinner')).toBeNull();
    expect(screen.getByLabelText('Queued')).toBeTruthy();
    expect(screen.getByText('queued')).toBeTruthy();
    expect(screen.getByTestId('tool-row').getAttribute('data-state')).toBe('queued');
  });

  it('shows ✓ with summary and duration when done', () => {
    renderWithProviders(
      <ToolCallRow
        block={{ call, state: 'ok', result: tool('t1', 'c1', { summary: 'src/a.ts:1-10', durationMs: 1400 }) }}
      />,
    );
    expect(screen.getByLabelText('Succeeded')).toBeTruthy();
    expect(screen.getByText('src/a.ts:1-10')).toBeTruthy();
    expect(screen.getByText('1.4s')).toBeTruthy();
    expect(screen.queryByTestId('spinner')).toBeNull();
  });

  it('shows ✕ when the tool failed', () => {
    renderWithProviders(
      <ToolCallRow block={{ call, state: 'failed', result: tool('t1', 'c1', { ok: false, output: 'Binary file' }) }} />,
    );
    expect(screen.getByLabelText('Failed')).toBeTruthy();
  });

  it('expands to formatted args and the output', () => {
    renderWithProviders(
      <ToolCallRow block={{ call, state: 'ok', result: tool('t1', 'c1', { output: 'line one' }) }} />,
    );
    const button = screen.getByRole('button', { name: /read_file/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('line one')).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('line one')).toBeTruthy();
    expect(screen.getByText(/"path": "src\/a\.ts"/)).toBeTruthy();
  });
});

describe('Markdown', () => {
  it('renders GFM: tables, task lists, external links, inline code', () => {
    renderWithProviders(
      <Markdown
        text={
          '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\nSee [docs](https://example.com) and `code`.'
        }
      />,
    );
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('code').tagName).toBe('CODE');
  });

  it('finds an unclosed fence', () => {
    expect(findOpenFence('text\n\n```ts\nconst a = 1')).toBe(6);
    expect(findOpenFence('```ts\nconst a = 1\n```\n')).toBeNull();
    expect(findOpenFence('```ts\nx\n```\n\n~~~\nopen')).toBe(13);
    expect(findOpenFence('plain')).toBeNull();
  });

  it('highlights only completed code blocks while streaming', async () => {
    const closed = '```ts\nconst a = 1\n```';
    const { container, rerender } = renderWithProviders(
      <Markdown streaming text={`${closed}\n\n\`\`\`ts\nconst b = 2`} />,
    );
    await waitFor(() => expect(container.querySelectorAll('code[data-highlighted="true"]')).toHaveLength(1), {
      timeout: 10_000,
    });
    const codes = container.querySelectorAll('pre code');
    expect(codes).toHaveLength(2);
    expect(codes[0]?.getAttribute('data-highlighted')).toBe('true');
    expect(codes[1]?.getAttribute('data-highlighted')).toBeNull();
    expect(codes[1]?.textContent).toBe('const b = 2');
    void rerender;
  });
});

describe('Conversation run overlay', () => {
  it('shows the pending message and "Thinking…" before the first token', async () => {
    const { api, chat } = await seededChat();
    const pending: UserMessage = { ...user(`${PENDING_PREFIX}1`, 'brand new question'), attachments: [] };
    useRunsStore.setState({ runs: { [chat.id]: createRun(1, pending) } });
    renderWithProviders(<Conversation chatId={chat.id} />, { api });
    expect(await screen.findByText('brand new question')).toBeTruthy();
    expect(screen.getByText('Thinking…')).toBeTruthy();
  });

  it('shows streamed text without "Thinking…" and spinners for running tools', async () => {
    const { api, chat } = await seededChat();
    const call = { id: 'cx', name: 'read_file', argsJson: '{"path":"x.ts"}' };
    useRunsStore.setState({
      runs: {
        [chat.id]: {
          ...createRun(1, user('ux', 'go')),
          messages: [user('ux', 'go'), assistant('ax', 'reading now', { toolCalls: [call] })],
          runningToolIds: ['cx'],
        },
      },
    });
    renderWithProviders(<Conversation chatId={chat.id} />, { api });
    expect(await screen.findByText('reading now')).toBeTruthy();
    expect(screen.queryByText('Thinking…')).toBeNull();
    const rows = screen.getAllByTestId('tool-row');
    expect(rows.at(-1)?.getAttribute('data-state')).toBe('running');
  });

  it('marks only the running call as running; later calls are queued', async () => {
    const { api, chat } = await seededChat();
    const cx = { id: 'cx', name: 'read_file', argsJson: '{"path":"x.ts"}' };
    const cy = { id: 'cy', name: 'read_file', argsJson: '{"path":"y.ts"}' };
    useRunsStore.setState({
      runs: {
        [chat.id]: {
          ...createRun(1, user('ux', 'go')),
          messages: [user('ux', 'go'), assistant('ax', 'reading now', { toolCalls: [cx, cy] })],
          runningToolIds: ['cx'],
        },
      },
    });
    renderWithProviders(<Conversation chatId={chat.id} />, { api });
    await screen.findByText('reading now');
    const rows = screen.getAllByTestId('tool-row').slice(-2);
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['running', 'queued']);
  });

  it('error card: "Open settings" for key errors', async () => {
    const { api, chat } = await seededChat();
    useRunsStore.setState({
      runs: { [chat.id]: { ...createRun(1), status: 'idle', error: errorInfo('invalid_api_key') } },
    });
    renderWithProviders(<Conversation chatId={chat.id} />, { api });
    const card = await screen.findByTestId('error-card');
    expect(within(card).queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Open settings' }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it('error card: "Retry" for retryable errors calls retry', async () => {
    const { api, chat } = await seededChat();
    const retry = vi.spyOn(api, 'retry');
    useRunsStore.setState({
      runs: { [chat.id]: { ...createRun(1), status: 'idle', error: errorInfo('provider_error') } },
    });
    renderWithProviders(<Conversation chatId={chat.id} />, { api });
    const card = await screen.findByTestId('error-card');
    expect(within(card).queryByRole('button', { name: 'Open settings' })).toBeNull();
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0]?.[1]).toEqual({ model: chat.model });
    await waitFor(() => expect(screen.queryByTestId('error-card')).toBeNull());
  });

  it('renders a persisted assistant error inline, once', async () => {
    const { api, chat } = await seededChat();
    const full: Chat = {
      ...chat,
      messages: [user('u1', 'q'), assistant('a1', '', { status: 'error', error: errorInfo('insufficient_credits') })],
    };
    useRunsStore.setState({
      runs: { [chat.id]: { ...createRun(1), status: 'idle', error: errorInfo('insufficient_credits') } },
    });
    renderWithProviders(<Conversation chatId={chat.id} />, { api, chats: [full] });
    const cards = await screen.findAllByTestId('error-card');
    expect(cards).toHaveLength(1);
    expect(within(cards[0] as HTMLElement).getByRole('button', { name: 'Open settings' })).toBeTruthy();
  });
});
