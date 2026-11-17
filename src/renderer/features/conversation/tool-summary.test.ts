import type { ToolMessage } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { summarizeGroup } from './tool-summary';
import type { ToolBlock, ToolGroupItem, ToolState } from './turns';

let seq = 0;

/** A tool block; `ok` and `failed` calls get a result, `queued`, `running` and `skipped` ones do not. */
function step(
  name: string,
  args: Record<string, unknown> | string,
  state: ToolState = 'ok',
  durationMs = 200,
): ToolBlock {
  seq += 1;
  const id = `c${seq}`;
  const argsJson = typeof args === 'string' ? args : JSON.stringify(args);
  const result: ToolMessage | undefined =
    state === 'ok' || state === 'failed'
      ? {
          id: `r${seq}`,
          role: 'tool',
          createdAt: '2026-01-01T00:00:00.000Z',
          toolCallId: id,
          name,
          ok: state === 'ok',
          output: '',
          summary: '',
          durationMs,
        }
      : undefined;
  return { kind: 'tool', key: `m:${id}`, messageId: 'm', call: { id, name, argsJson }, result, state };
}

const read = (path: string, state?: ToolState, ms?: number) => step('read_file', { path }, state, ms);
const search = (query: string, state?: ToolState) => step('search', { query }, state);
const list = (path: string, state?: ToolState) => step('list_files', { path }, state);
const edit = (path: string, state?: ToolState) => step('edit_file', { path }, state);
const write = (path: string, state?: ToolState) => step('write_file', { path }, state);
const del = (path: string, state?: ToolState) => step('delete_file', { path }, state);
const terminal = (state?: ToolState) => step('read_terminal', {}, state);
const other = (name: string, state?: ToolState) => step(name, {}, state);

function group(blocks: ToolBlock[], live = false): ToolGroupItem {
  return { kind: 'group', key: blocks[0]?.key ?? '', blocks, live };
}

/** The header's plain label for a settled group of these calls. */
const label = (blocks: ToolBlock[]): string => summarizeGroup(group(blocks)).text;

describe('summarizeGroup: settled label', () => {
  it('pluralises each clause, and uses the singular for one', () => {
    expect(label([read('a.ts'), read('b.ts'), read('c.ts')])).toBe('Read 3 files');
    expect(label([search('x'), search('y')])).toBe('Searched 2 times');
    expect(label([search('x'), list('src'), list('lib')])).toBe('Searched 1 time, listed 2 folders');
    expect(label([read('a.ts'), search('x')])).toBe('Read a.ts, searched 1 time');
    expect(label([terminal(), terminal()])).toBe('Read the terminal 2 times');
    expect(label([terminal(), search('x')])).toBe('Searched 1 time, read the terminal');
    expect(label([other('a'), other('b')])).toBe('Used 2 other tools');
    expect(label([other('frobnicate'), read('a.ts')])).toBe('Read a.ts, used 1 other tool');
    expect(label([list('src'), search('x')])).toBe('Searched 1 time, listed 1 folder');
    // An edit whose arguments do not parse counts as one file that has no name.
    expect(label([step('edit_file', 'not json'), search('x')])).toBe('Searched 1 time, edited 1 file');
    expect(label([step('read_file', '{not json'), search('x')])).toBe('Read 1 file, searched 1 time');
  });

  it('orders the clauses read, searched, listed, edited, read the terminal, used', () => {
    const blocks = [
      read('a.ts'),
      read('b.ts'),
      read('c.ts'),
      search('x'),
      list('src'),
      edit('d.ts'),
      terminal(),
      other('frobnicate'),
    ];
    const summary = summarizeGroup(group(blocks));
    expect(summary.clauses.map((c) => c.verb)).toEqual(['read', 'searched', 'listed', 'edited', 'read', 'used']);
    expect(summary.text).toBe(
      'Read 3 files, searched 1 time, listed 1 folder, edited 1 file, read the terminal, used 1 other tool',
    );
  });

  it('counts a repeated read path once', () => {
    expect(label([read('a.ts'), read('a.ts')])).toBe('Read a.ts');
    const summary = summarizeGroup(group([read('a.ts'), read('a.ts'), read('b.ts')]));
    expect(summary.clauses[0]?.count).toBe(2);
    expect(summary.text).toBe('Read a.ts and b.ts');
  });

  it('names files when the label has at most two clauses and the clause at most two paths', () => {
    const two = summarizeGroup(group([read('src/core/loop.ts'), read('src/core/constants.ts')]));
    expect(two.text).toBe('Read loop.ts and constants.ts');
    expect(two.clauses[0]?.names).toEqual(['loop.ts', 'constants.ts']);

    expect(label([read('src/core/loop.ts'), read('src/core/constants.ts'), edit('src/core/loop.ts')])).toBe(
      'Read loop.ts and constants.ts, edited loop.ts',
    );
    expect(label([edit('a.ts'), write('a.ts'), del('b.ts')])).toBe('Edited a.ts and b.ts');
  });

  it('counts a clause that has more than two paths, and still names the other clause', () => {
    expect(label([read('a.ts'), read('b.ts'), read('c.ts')])).toBe('Read 3 files');
    expect(label([read('a.ts'), read('b.ts'), read('c.ts'), search('x')])).toBe('Read 3 files, searched 1 time');
    expect(label([read('a.ts'), read('b.ts'), read('c.ts'), edit('d.ts')])).toBe('Read 3 files, edited d.ts');
  });

  it('counts instead of naming when the label has more than two clauses', () => {
    const summary = summarizeGroup(group([read('a.ts'), search('x'), edit('a.ts')]));
    expect(summary.text).toBe('Read 1 file, searched 1 time, edited 1 file');
    expect(summary.clauses.every((c) => c.names === null)).toBe(true);
  });

  it('counts a call whose arguments do not parse as its own file, which stops the naming', () => {
    expect(label([read('a.ts'), step('read_file', '{not json')])).toBe('Read 2 files');
    expect(label([step('read_file', '{not json'), step('read_file', '{not json')])).toBe('Read 2 files');
    expect(label([edit('a.ts'), step('edit_file', 'oops')])).toBe('Edited 2 files');
  });

  it('adds "· N failed" and "· N not run" after the clauses', () => {
    const failed = summarizeGroup(group([read('a.ts'), read('b.ts', 'failed')]));
    expect(failed.text).toBe('Read a.ts and b.ts · 1 failed');
    expect(failed.failed).toBe(1);
    expect(failed.state).toBe('failed');

    const notRun = summarizeGroup(group([read('a.ts'), read('b.ts', 'skipped')]));
    expect(notRun.text).toBe('Read a.ts and b.ts · 1 not run');
    expect(notRun.notRun).toBe(1);
    expect(notRun.state).toBe('ok');

    const both = summarizeGroup(group([read('a.ts', 'failed'), read('b.ts', 'skipped'), search('x')]));
    expect(both.text).toBe('Read a.ts and b.ts, searched 1 time · 1 failed · 1 not run');
  });

  it('sums the durations of the calls that have results', () => {
    expect(summarizeGroup(group([read('a.ts', 'ok', 200), read('b.ts', 'failed', 1400)])).durationMs).toBe(1600);
    expect(summarizeGroup(group([read('a.ts', 'ok', 200), read('b.ts', 'skipped')])).durationMs).toBe(200);
  });

  it('has no current step once settled', () => {
    expect(summarizeGroup(group([read('a.ts'), read('b.ts')])).current).toBeNull();
  });
});

describe('summarizeGroup: live header', () => {
  it.each([
    ['read_file', { path: 'src/a.ts' }, 'Reading src/a.ts…'],
    ['search', { query: 'foo' }, 'Searching "foo"…'],
    ['list_files', { path: 'src' }, 'Listing src…'],
    ['edit_file', { path: 'a.ts' }, 'Editing a.ts…'],
    ['write_file', { path: 'a.ts' }, 'Writing a.ts…'],
    ['delete_file', { path: 'a.ts' }, 'Deleting a.ts…'],
    ['read_terminal', {}, 'Reading the terminal…'],
    ['frobnicate', {}, 'Running frobnicate…'],
  ])('shows the running %s call in the present tense', (name, args, expected) => {
    const summary = summarizeGroup(group([step(name, args, 'running'), read('z.ts', 'queued')], true));
    expect(summary.current).toBe(expected);
    expect(summary.text).toBe(expected);
    expect(summary.state).toBe('live');
  });

  it.each([
    ['read_file', { path: 'src/a.ts' }, 'Read src/a.ts'],
    ['search', { query: 'foo' }, 'Searched "foo"'],
    ['list_files', { path: 'src' }, 'Listed src'],
    ['edit_file', { path: 'a.ts' }, 'Edited a.ts'],
    ['write_file', { path: 'a.ts' }, 'Wrote a.ts'],
    ['delete_file', { path: 'a.ts' }, 'Deleted a.ts'],
    ['read_terminal', {}, 'Read the terminal'],
    ['frobnicate', {}, 'Ran frobnicate'],
  ])('between calls, names the last finished %s call in the past tense', (name, args, expected) => {
    const summary = summarizeGroup(group([step(name, args, 'ok'), read('z.ts', 'queued')], true));
    expect(summary.current).toBe(expected);
  });

  it('shows a queued-only group as its first queued call in the present tense', () => {
    const summary = summarizeGroup(group([read('a.ts', 'queued'), read('b.ts', 'queued')], true));
    expect(summary.current).toBe('Reading a.ts…');
    expect(summary.text).toBe('Reading a.ts…');
  });

  it('reads "Working…" when a live group has nothing running, finished or queued', () => {
    const summary = summarizeGroup(group([read('a.ts', 'skipped'), read('b.ts', 'skipped')], true));
    expect(summary.current).toBe('Working…');
  });

  it('builds the live label as current · past clauses · suffixes', () => {
    const summary = summarizeGroup(group([read('a.ts'), search('x', 'running'), read('b.ts', 'failed')], true));
    expect(summary.text).toBe('Searching "x"… · read a.ts and b.ts · 1 failed');
    expect(summary.state).toBe('live');
    expect(summary.failed).toBe(1);
  });

  it('counts only the finished calls in the live clauses', () => {
    const summary = summarizeGroup(group([read('a.ts'), read('b.ts', 'running')], true));
    expect(summary.text).toBe('Reading b.ts… · read a.ts');
  });

  it('between calls, the clauses cover every finished call', () => {
    const summary = summarizeGroup(group([read('a.ts'), read('b.ts')], true));
    expect(summary.current).toBe('Read b.ts');
    expect(summary.text).toBe('Read b.ts · read a.ts and b.ts');
  });
});

describe('summarizeGroup: live label vs. settled label', () => {
  it('settles to the plain label once the group is no longer live', () => {
    const blocks = [read('a.ts'), read('b.ts')];
    expect(summarizeGroup(group(blocks, true)).text).toBe('Read b.ts · read a.ts and b.ts');
    expect(summarizeGroup(group(blocks, false)).text).toBe('Read a.ts and b.ts');
  });
});
