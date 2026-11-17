import { errorInfo } from '@shared/errors';
import type { AssistantMessage, Message, ToolCall } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { buildTurns, groupBlocks, type TextBlock, type ToolBlock, type ToolState, type TurnItem } from './turns';

const text = (key: string, extra: Partial<TextBlock> = {}): TextBlock => ({
  kind: 'text',
  key,
  messageId: key,
  text: 'answer',
  streaming: false,
  status: 'complete',
  ...extra,
});

const tool = (key: string, name = 'read_file', state: ToolState = 'ok'): ToolBlock => ({
  kind: 'tool',
  key,
  messageId: 'a1',
  call: { id: `call-${key}`, name, argsJson: JSON.stringify({ path: `${key}.ts` }) },
  state,
});

/** One string per item (`text:<key>`, `tool:<key>` or `group:<block keys>`), so a layout reads as the expectation. */
function shape(items: TurnItem[]): string[] {
  return items.map((item) =>
    item.kind === 'group' ? `group:${item.blocks.map((b) => b.key).join(',')}` : `${item.kind}:${item.key}`,
  );
}

function groupAt(items: TurnItem[], index: number) {
  const item = items[index];
  if (item?.kind !== 'group') throw new Error(`expected a group at ${index}, got ${item?.kind ?? 'nothing'}`);
  return item;
}

describe('groupBlocks: runs of tool calls', () => {
  it('folds two or more consecutive tool calls into one group between texts', () => {
    const items = groupBlocks([text('t1'), tool('a'), tool('b'), text('t2')], { live: false });
    expect(shape(items)).toEqual(['text:t1', 'group:a,b', 'text:t2']);
  });

  it('leaves one tool call as a plain tool item, the same block object', () => {
    const single = tool('a');
    const items = groupBlocks([text('t1'), single, text('t2')], { live: false });
    expect(shape(items)).toEqual(['text:t1', 'tool:a', 'text:t2']);
    expect(items[1]).toBe(single);
  });

  it('lets an edit join the run: read, edit, read is one group of three', () => {
    const items = groupBlocks([tool('a', 'read_file'), tool('b', 'edit_file'), tool('c', 'read_file')], {
      live: false,
    });
    expect(shape(items)).toEqual(['group:a,b,c']);
  });

  it('makes an edit-only run of two a group', () => {
    const items = groupBlocks([tool('a', 'edit_file'), tool('b', 'write_file')], { live: false });
    expect(shape(items)).toEqual(['group:a,b']);
  });

  it('includes read_terminal in a run', () => {
    const items = groupBlocks([tool('a', 'read_file'), tool('b', 'read_terminal')], { live: false });
    expect(shape(items)).toEqual(['group:a,b']);
  });

  it('keeps an empty streaming text block from splitting the run', () => {
    const items = groupBlocks([tool('a'), text('t1', { text: '', streaming: true }), tool('b')], { live: false });
    expect(shape(items)).toEqual(['group:a,b']);
  });

  it('drops an empty finished text block too, so runs on either side merge', () => {
    const items = groupBlocks([tool('a'), text('t1', { text: '' }), tool('b')], { live: false });
    expect(shape(items)).toEqual(['group:a,b']);
  });

  it('splits the run at stopped and error text blocks, even without text', () => {
    const stopped = groupBlocks([tool('a'), tool('b'), text('t1', { text: '', status: 'stopped' }), tool('c')], {
      live: false,
    });
    expect(shape(stopped)).toEqual(['group:a,b', 'text:t1', 'tool:c']);

    const failed = groupBlocks(
      [tool('a'), tool('b'), text('t1', { text: '', status: 'error', error: errorInfo('provider_error') }), tool('c')],
      { live: false },
    );
    expect(shape(failed)).toEqual(['group:a,b', 'text:t1', 'tool:c']);
  });

  it('merges tool-only steps across two assistant messages', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', createdAt: 'x', text: 'q', attachments: [] },
      assistant('a1', [{ id: 'c1', name: 'read_file', argsJson: '{"path":"a.ts"}' }]),
      {
        id: 't1',
        role: 'tool',
        createdAt: 'x',
        toolCallId: 'c1',
        name: 'read_file',
        ok: true,
        output: '',
        summary: '',
        durationMs: 1,
      },
      assistant('a2', [{ id: 'c2', name: 'search', argsJson: '{"query":"x"}' }]),
      {
        id: 't2',
        role: 'tool',
        createdAt: 'x',
        toolCallId: 'c2',
        name: 'search',
        ok: true,
        output: '',
        summary: '',
        durationMs: 1,
      },
    ];
    // a2 is still streaming with no text yet: its empty placeholder must not split the run either.
    const [turn] = buildTurns(messages, { active: false, streamingId: 'a2', runningToolIds: [] });
    expect(turn?.blocks.map((b) => b.kind)).toEqual(['tool', 'text', 'tool']);
    const items = groupBlocks(turn?.blocks ?? [], { live: false });
    expect(shape(items)).toEqual(['group:a1:c1,a2:c2']);
  });

  it('keys a group by its first block and keeps that key as blocks are appended', () => {
    const two = groupAt(groupBlocks([tool('a'), tool('b')], { live: false }), 0);
    const three = groupAt(groupBlocks([tool('a'), tool('b'), tool('c')], { live: true }), 0);
    expect(two.key).toBe('a');
    expect(three.key).toBe('a');
  });
});

describe('groupBlocks: live state', () => {
  it('is live while a call is running, whether or not it is the last item', () => {
    const items = groupBlocks([tool('a', 'read_file', 'running'), tool('b'), text('t1')], { live: false });
    expect(groupAt(items, 0).live).toBe(true);
  });

  it('is live while a call is queued', () => {
    const items = groupBlocks([tool('a'), tool('b', 'read_file', 'queued')], { live: false });
    expect(groupAt(items, 0).live).toBe(true);
  });

  it('stays live across the gap between sequential calls when it is the last item of the live turn', () => {
    const items = groupBlocks([tool('a'), tool('b')], { live: true });
    expect(groupAt(items, 0).live).toBe(true);
  });

  it('is not live in the gap when the turn is not the live one', () => {
    const items = groupBlocks([tool('a'), tool('b')], { live: false });
    expect(groupAt(items, 0).live).toBe(false);
  });

  it('is not live in the gap once a text follows it', () => {
    const items = groupBlocks([tool('a'), tool('b'), text('t1')], { live: true });
    expect(groupAt(items, 0).live).toBe(false);
  });

  it('settles after a stop: skipped calls do not keep the group live', () => {
    const items = groupBlocks([tool('a'), tool('b', 'read_file', 'skipped')], { live: false });
    expect(groupAt(items, 0).live).toBe(false);
    const allSkipped = groupBlocks([tool('a', 'read_file', 'skipped'), tool('b', 'read_file', 'skipped')], {
      live: false,
    });
    expect(groupAt(allSkipped, 0).live).toBe(false);
  });
});

/** An assistant message that made these calls, with no visible text. */
function assistant(id: string, toolCalls: ToolCall[]): AssistantMessage {
  return { id, role: 'assistant', createdAt: 'x', model: 'm', text: '', toolCalls, status: 'complete' };
}
