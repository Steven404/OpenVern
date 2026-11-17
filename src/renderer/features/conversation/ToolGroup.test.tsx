import type { ToolMessage } from '@shared/types';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installDomStubs } from '../composer/test-utils';
import { AssistantTurn } from './AssistantTurn';
import { toolCallRowPropsEqual } from './ToolCallRow';
import { ToolGroup, toolGroupPropsEqual } from './ToolGroup';
import { groupBlocks, type TextBlock, type ToolBlock, type ToolGroupItem, type ToolState } from './turns';

beforeAll(installDomStubs);
afterEach(cleanup);

const T = '2026-01-01T00:00:00.000Z';

/** A read_file call on `path`; `ok` and `failed` calls get a result, the others do not. */
function step(key: string, path: string, state: ToolState = 'ok', durationMs = 200, name = 'read_file'): ToolBlock {
  const id = `call-${key}`;
  const result: ToolMessage | undefined =
    state === 'ok' || state === 'failed'
      ? {
          id: `result-${key}`,
          role: 'tool',
          createdAt: T,
          toolCallId: id,
          name,
          ok: state === 'ok',
          output: `output of ${path}`,
          summary: path,
          durationMs,
        }
      : undefined;
  return {
    kind: 'tool',
    key: `a1:${id}`,
    messageId: 'a1',
    call: { id, name, argsJson: JSON.stringify({ path }) },
    result,
    state,
  };
}

/** The group the grouping rules make from these blocks. */
function groupOf(blocks: ToolBlock[], live = false): ToolGroupItem {
  const [item] = groupBlocks(blocks, { live });
  if (item?.kind !== 'group') throw new Error('expected a group');
  return item;
}

/** A copy of the block with fresh objects everywhere, as a store update would produce. */
const reallocated = (b: ToolBlock): ToolBlock => ({
  ...b,
  call: { ...b.call },
  result: b.result && { ...b.result },
});

const withResultId = (b: ToolBlock, id: string): ToolBlock => ({ ...b, result: b.result && { ...b.result, id } });

const header = (): HTMLElement => {
  const [button] = within(screen.getByTestId('tool-group')).getAllByRole('button');
  if (!button) throw new Error('no group header');
  return button;
};

describe('toolGroupPropsEqual', () => {
  const a = step('a', 'a.ts');
  const b = step('b', 'b.ts');

  it('is equal for re-allocated but identical blocks', () => {
    const prev = { group: groupOf([a, b]) };
    const next = { group: groupOf([reallocated(a), reallocated(b)]) };
    expect(toolGroupPropsEqual(prev, next)).toBe(true);
  });

  it('differs when a call changes state', () => {
    const prev = { group: groupOf([a, step('b', 'b.ts', 'running')], true) };
    const next = { group: groupOf([a, step('b', 'b.ts', 'ok')], true) };
    expect(toolGroupPropsEqual(prev, next)).toBe(false);
  });

  it('differs when a result changes', () => {
    const prev = { group: groupOf([a, b]) };
    const next = { group: groupOf([a, withResultId(b, 'result-b-2')]) };
    expect(toolGroupPropsEqual(prev, next)).toBe(false);
  });

  it('differs when the group grows, changes key, or changes liveness', () => {
    const prev = { group: groupOf([a, b]) };
    expect(toolGroupPropsEqual(prev, { group: groupOf([a, b, step('c', 'c.ts')]) })).toBe(false);
    expect(toolGroupPropsEqual(prev, { group: groupOf([b, a]) })).toBe(false);
    expect(toolGroupPropsEqual(prev, { group: groupOf([a, b], true) })).toBe(false);
  });
});

describe('toolCallRowPropsEqual', () => {
  const block = step('a', 'a.ts');

  it('is equal for re-allocated but identical blocks', () => {
    expect(toolCallRowPropsEqual({ block }, { block: reallocated(block) })).toBe(true);
  });

  it('differs when the state, the result or the arguments change', () => {
    expect(toolCallRowPropsEqual({ block }, { block: { ...block, state: 'running', result: undefined } })).toBe(false);
    expect(toolCallRowPropsEqual({ block }, { block: withResultId(block, 'result-a-2') })).toBe(false);
    expect(
      toolCallRowPropsEqual(
        { block },
        { block: { ...block, call: { ...block.call, argsJson: '{"path":"other.ts"}' } } },
      ),
    ).toBe(false);
  });

  it('differs when the variant changes', () => {
    expect(toolCallRowPropsEqual({ block, variant: 'card' }, { block, variant: 'inGroup' })).toBe(false);
  });
});

describe('ToolGroup', () => {
  it('collapsed: no call rows, a native button that controls the panel, named by the summary', () => {
    render(<ToolGroup group={groupOf([step('a', 'a.ts'), step('b', 'b.ts')])} />);
    const button = screen.getByRole('button', { name: 'Read a.ts and b.ts' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBeTruthy();
    expect(screen.queryAllByTestId('tool-row')).toHaveLength(0);
  });

  it('a click shows one row per call, and each row still expands', () => {
    render(<ToolGroup group={groupOf([step('a', 'a.ts'), step('b', 'b.ts')])} />);
    const button = screen.getByRole('button', { name: 'Read a.ts and b.ts' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(button.getAttribute('aria-controls') ?? '')).not.toBeNull();
    expect(screen.getAllByTestId('tool-row')).toHaveLength(2);

    const [first] = screen.getAllByRole('button', { name: /read_file/ });
    expect(first?.getAttribute('aria-expanded')).toBe('false');
    if (!first) throw new Error('no row');
    fireEvent.click(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/"path": "a\.ts"/)).toBeTruthy();
  });

  it('keeps its open state through a rerender that appends a block and then settles', () => {
    const { rerender } = render(
      <AssistantTurn blocks={[step('a', 'a.ts', 'running'), step('b', 'b.ts', 'queued')]} live />,
    );
    fireEvent.click(header());
    const group = screen.getByTestId('tool-group');
    expect(group.getAttribute('data-state')).toBe('live');
    expect(screen.getAllByTestId('tool-row')).toHaveLength(2);

    rerender(
      <AssistantTurn blocks={[step('a', 'a.ts'), step('b', 'b.ts', 'running'), step('c', 'c.ts', 'queued')]} live />,
    );
    expect(screen.getByTestId('tool-group')).toBe(group);
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByTestId('tool-row')).toHaveLength(3);

    rerender(<AssistantTurn blocks={[step('a', 'a.ts'), step('b', 'b.ts'), step('c', 'c.ts')]} />);
    expect(screen.getByTestId('tool-group')).toBe(group);
    expect(group.getAttribute('data-state')).toBe('ok');
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByTestId('tool-row')).toHaveLength(3);
  });

  it('a failure shows the ✕, the danger clause, and an accessible name that says "failed"', () => {
    render(<ToolGroup group={groupOf([step('a', 'a.ts'), step('b', 'b.ts', 'failed')])} />);
    const button = screen.getByRole('button', { name: /failed/ });
    expect(button.getAttribute('aria-label')).toBe('Read a.ts and b.ts · 1 failed');
    expect(screen.getByTestId('tool-group').getAttribute('data-state')).toBe('failed');
    expect(button.querySelector('svg.text-danger')).not.toBeNull();
    expect(screen.getByText(/1 failed/).className).toContain('text-danger');
  });

  it('shows the duration when the calls have results, and hides it when it sums to zero', () => {
    const { unmount } = render(
      <ToolGroup group={groupOf([step('a', 'a.ts', 'ok', 200), step('b', 'b.ts', 'ok', 400)])} />,
    );
    expect(within(header()).getByText('0.6s')).toBeTruthy();
    unmount();

    render(<ToolGroup group={groupOf([step('a', 'a.ts', 'queued'), step('b', 'b.ts', 'queued')])} />);
    expect(header().textContent).not.toMatch(/\d+(\.\d)?s$/);
  });

  it('the live header shows the current path and a spinner, and carries no status role', () => {
    render(<ToolGroup group={groupOf([step('a', 'src/a.ts', 'running'), step('b', 'b.ts', 'queued')], true)} />);
    const group = screen.getByTestId('tool-group');
    expect(group.getAttribute('data-state')).toBe('live');
    expect(within(group).getByTestId('spinner')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reading src/a.ts…' })).toBeTruthy();
    expect(group.querySelector('[role="status"]')).toBeNull();
  });
});

describe('AssistantTurn with tool groups', () => {
  it('a collapsed group renders no tool rows', () => {
    render(<AssistantTurn blocks={[step('a', 'a.ts'), step('b', 'b.ts')]} />);
    expect(screen.getAllByTestId('tool-group')).toHaveLength(1);
    expect(screen.queryAllByTestId('tool-row')).toHaveLength(0);
  });

  it('a single call stays a plain row with no group', () => {
    render(<AssistantTurn blocks={[step('a', 'a.ts')]} />);
    expect(screen.getAllByTestId('tool-row')).toHaveLength(1);
    expect(screen.queryByTestId('tool-group')).toBeNull();
  });

  it('a text between calls splits them into a group and a row', () => {
    const text: TextBlock = {
      kind: 'text',
      key: 'a2',
      messageId: 'a2',
      text: 'between the steps',
      streaming: false,
      status: 'complete',
    };
    render(<AssistantTurn blocks={[step('a', 'a.ts'), step('b', 'b.ts'), text, step('c', 'c.ts')]} />);
    expect(screen.getAllByTestId('tool-group')).toHaveLength(1);
    expect(screen.getAllByTestId('tool-row')).toHaveLength(1);
    expect(screen.getByText('between the steps')).toBeTruthy();
  });

  it('the Proposed edits footer stays visible while a group is collapsed', () => {
    render(<AssistantTurn blocks={[step('a', 'a.ts'), step('b', 'b.ts')]} footer={<p>Proposed edits</p>} />);
    expect(screen.getByText('Proposed edits')).toBeTruthy();
    expect(screen.queryAllByTestId('tool-row')).toHaveLength(0);
  });

  it('the trailing group is live between calls, and settles once the run is over', () => {
    const blocks = [step('a', 'a.ts'), step('b', 'b.ts')];
    const { rerender } = render(<AssistantTurn blocks={blocks} live />);
    expect(screen.getByTestId('tool-group').getAttribute('data-state')).toBe('live');
    expect(screen.getByRole('button', { name: 'Read b.ts · read a.ts and b.ts' })).toBeTruthy();

    rerender(<AssistantTurn blocks={blocks} live={false} />);
    expect(screen.getByTestId('tool-group').getAttribute('data-state')).toBe('ok');
    expect(screen.getByRole('button', { name: 'Read a.ts and b.ts' })).toBeTruthy();
  });
});
