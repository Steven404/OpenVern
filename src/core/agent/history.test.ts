import type { AssistantMessage, Message, ToolMessage, UserMessage } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { buildHistory, INTERRUPTED_OUTPUT } from './history';

const user = (text: string, attachments: UserMessage['attachments'] = []): UserMessage => ({
  id: crypto.randomUUID(),
  role: 'user',
  createdAt: 't',
  text,
  attachments,
});
const assistant = (over: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  createdAt: 't',
  model: 'm',
  text: 'hi',
  toolCalls: [],
  status: 'complete',
  ...over,
});
const tool = (toolCallId: string, output: string): ToolMessage => ({
  id: crypto.randomUUID(),
  role: 'tool',
  createdAt: 't',
  toolCallId,
  name: 'read_file',
  ok: true,
  output,
  summary: 's',
  durationMs: 1,
});

const opts = (over: Partial<Parameters<typeof buildHistory>[1]> = {}) => ({
  model: 'm',
  supportsImages: true,
  toolsOffered: true,
  readAttachment: async () => new TextEncoder().encode('data'),
  ...over,
});

describe('buildHistory', () => {
  it('never sends the UI-only notice to the provider', async () => {
    const out = await buildHistory([user('q'), assistant({ text: 'a', notice: 'Some notice' })], opts());
    expect(JSON.stringify(out)).not.toContain('Some notice');
    expect(out[1]).not.toHaveProperty('notice');
  });

  it('maps user, assistant and tool messages in order', async () => {
    const call = { id: 'c1', name: 'read_file', argsJson: '{}' };
    const messages: Message[] = [
      user('q'),
      assistant({ text: 'x', toolCalls: [call] }),
      tool('c1', 'out'),
      assistant({ text: 'done' }),
    ];
    expect(await buildHistory(messages, opts())).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', text: 'x', toolCalls: [call] },
      { role: 'tool', toolCallId: 'c1', content: 'out' },
      { role: 'assistant', text: 'done', toolCalls: [] },
    ]);
  });

  it('adds a synthetic Interrupted result for tool calls without one', async () => {
    const calls = [
      { id: 'c1', name: 'read_file', argsJson: '{}' },
      { id: 'c2', name: 'read_file', argsJson: '{}' },
    ];
    const history = await buildHistory([user('q'), assistant({ toolCalls: calls }), tool('c1', 'real')], opts());
    expect(history.slice(2)).toEqual([
      { role: 'tool', toolCallId: 'c1', content: 'real' },
      { role: 'tool', toolCallId: 'c2', content: INTERRUPTED_OUTPUT },
    ]);
  });

  it('includes stopped and error assistant messages with their text, skips empty ones, drops orphan tool results', async () => {
    const history = await buildHistory(
      [
        user('q'),
        assistant({ status: 'stopped', text: 'part' }),
        user('again'),
        assistant({ status: 'error', text: '', error: { code: 'internal', message: 'x', retryable: true } }),
        tool('ghost', 'orphan'),
        user('third'),
      ],
      opts(),
    );
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(history[1]).toMatchObject({ text: 'part' });
  });

  it('inlines text attachments before the text, escaping the name', async () => {
    const att = { id: 'a1', name: 'we"ird.ts', mime: 'text/plain', size: 4, kind: 'text' as const };
    const [m] = await buildHistory([user('look', [att])], opts());
    expect(m).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '<attached_file name="we&quot;ird.ts">\ndata\n</attached_file>' },
        { type: 'text', text: 'look' },
      ],
    });
  });

  it('sends images as base64 parts only for models that accept them', async () => {
    const att = { id: 'a1', name: 'p.png', mime: 'image/png', size: 4, kind: 'image' as const };
    const [withImages] = await buildHistory([user('q', [att])], opts());
    expect(withImages).toEqual({
      role: 'user',
      content: [
        { type: 'image', mime: 'image/png', base64: Buffer.from('data').toString('base64') },
        { type: 'text', text: 'q' },
      ],
    });
    let reads = 0;
    const [without] = await buildHistory(
      [user('q', [att])],
      opts({
        supportsImages: false,
        readAttachment: async () => {
          reads++;
          return new Uint8Array();
        },
      }),
    );
    expect(without).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[Image "p.png" omitted: the current model does not accept images]' },
        { type: 'text', text: 'q' },
      ],
    });
    expect(reads).toBe(0);
  });

  it('survives an attachment whose bytes are gone', async () => {
    const att = { id: 'a1', name: 'gone.txt', mime: 'text/plain', size: 4, kind: 'text' as const };
    const [m] = await buildHistory(
      [user('q', [att])],
      opts({
        readAttachment: async () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(m).toMatchObject({ content: [{ text: '[Attachment "gone.txt" is no longer available]' }, { text: 'q' }] });
  });

  it('replays providerMeta only for the model that produced it', async () => {
    const messages = [
      user('q'),
      assistant({ model: 'm', providerMeta: { r: 1 } }),
      assistant({ model: 'other', providerMeta: { r: 2 } }),
    ];
    const history = await buildHistory(messages, opts());
    expect(history[1]).toMatchObject({ providerMeta: { r: 1 } });
    expect(history[2]).not.toHaveProperty('providerMeta');
  });
});

describe('buildHistory without tools offered', () => {
  const c1 = { id: 'c1', name: 'read_file', argsJson: '{"path":"a"}' };
  const c2 = { id: 'c2', name: 'read_file', argsJson: '' };

  it('flattens tool calls and results into assistant text when no tools are offered', async () => {
    const messages: Message[] = [
      user('q'),
      assistant({ text: 'x', toolCalls: [c1, c2] }),
      tool('c1', 'out'),
      assistant({ text: 'done' }),
      user('q2'),
    ];
    expect(await buildHistory(messages, opts({ toolsOffered: false }))).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        text: `x\n\n[tool read_file {"path":"a"} → ok]\nout\n\n[tool read_file {} → error]\n${INTERRUPTED_OUTPUT}\n\ndone`,
        toolCalls: [],
      },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
    ]);
  });

  it('truncates long tool output and marks failed results when flattening', async () => {
    const failed: ToolMessage = { ...tool('c1', 'a'.repeat(2050)), ok: false };
    const history = await buildHistory(
      [user('q'), assistant({ text: '', toolCalls: [c1] }), failed],
      opts({ toolsOffered: false }),
    );
    const m = history[1];
    const text = m?.role === 'assistant' ? m.text : '';
    expect(text).toContain('→ error]');
    expect(text.endsWith(`${'a'.repeat(2000)}\n[… 50 more characters truncated]`)).toBe(true);
  });

  it('drops providerMeta from flattened messages; empty text gives just the tool block', async () => {
    const history = await buildHistory(
      [user('q'), assistant({ text: '', model: 'm', providerMeta: { r: 1 }, toolCalls: [c1] }), tool('c1', 'out')],
      opts({ toolsOffered: false }),
    );
    const m = history[1];
    expect(m).not.toHaveProperty('providerMeta');
    expect(m?.role === 'assistant' && m.text.startsWith('[tool')).toBe(true);
  });
});
