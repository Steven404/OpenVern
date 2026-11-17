// Pure summary of a tool group: the one-line label, the live step and the counts shown in its header.

import { summarizeArgs } from './ToolCallRow';
import type { ToolBlock, ToolGroupItem } from './turns';

export interface GroupSummary {
  /** Plain label, e.g. "Read 3 files, searched 2 times · 1 failed". Also the header's accessible name. */
  text: string;
  /** Structured clauses so names can render in mono. */
  clauses: {
    verb: string;
    count: number;
    noun: string;
    names: string[] | null;
  }[];
  /** Live only: present-tense current step, e.g. "Reading src/a.ts…". */
  current: string | null;
  failed: number;
  notRun: number;
  durationMs: number;
  state: 'live' | 'ok' | 'failed';
}

type Clause = GroupSummary['clauses'][number];

const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);
const TERMINAL_NOUN = 'the terminal';
/** A clause names files only when the whole label is short and the clause covers this few paths. */
const MAX_NAMED_PATHS = 2;
const MAX_NAMED_CLAUSES = 2;

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

function argsOf(argsJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The path a call works on, or null when its arguments don't parse or carry none. */
function pathOf(block: ToolBlock): string | null {
  const path = argsOf(block.call.argsJson)?.path;
  return typeof path === 'string' && path ? path : null;
}

/**
 * Distinct files touched by these calls. A call without a usable path counts as its own file and has no name, and
 * paths that share a basename are counted, not named, since the names would be indistinguishable.
 */
function distinctPaths(blocks: ToolBlock[]): {
  count: number;
  names: string[] | null;
} {
  const paths = new Set<string>();
  let unnamed = 0;
  for (const b of blocks) {
    const path = pathOf(b);
    if (path) paths.add(path);
    else unnamed += 1;
  }
  const names = [...paths].map(basename);
  return {
    count: paths.size + unnamed,
    names: unnamed > 0 || new Set(names).size < names.length ? null : names,
  };
}

function buildClauses(blocks: ToolBlock[]): Clause[] {
  const by = (pred: (name: string) => boolean) => blocks.filter((b) => pred(b.call.name));
  const reads = by((n) => n === 'read_file');
  const searches = by((n) => n === 'search');
  const lists = by((n) => n === 'list_files');
  const edits = by((n) => EDIT_TOOLS.has(n));
  const terminals = by((n) => n === 'read_terminal');
  const others = by(
    (n) => !EDIT_TOOLS.has(n) && n !== 'read_file' && n !== 'search' && n !== 'list_files' && n !== 'read_terminal',
  );

  const clauses: Clause[] = [];
  if (reads.length) {
    const { count, names } = distinctPaths(reads);
    clauses.push({
      verb: 'read',
      count,
      noun: plural(count, 'file', 'files'),
      names,
    });
  }
  if (searches.length) {
    clauses.push({
      verb: 'searched',
      count: searches.length,
      noun: plural(searches.length, 'time', 'times'),
      names: null,
    });
  }
  if (lists.length) {
    clauses.push({
      verb: 'listed',
      count: lists.length,
      noun: plural(lists.length, 'folder', 'folders'),
      names: null,
    });
  }
  if (edits.length) {
    const { count, names } = distinctPaths(edits);
    clauses.push({
      verb: 'edited',
      count,
      noun: plural(count, 'file', 'files'),
      names,
    });
  }
  if (terminals.length) {
    clauses.push({
      verb: 'read',
      count: terminals.length,
      noun: TERMINAL_NOUN,
      names: null,
    });
  }
  if (others.length) {
    clauses.push({
      verb: 'used',
      count: others.length,
      noun: plural(others.length, 'other tool', 'other tools'),
      names: null,
    });
  }
  // Short labels name their files instead of counting them.
  if (clauses.length > MAX_NAMED_CLAUSES) return clauses.map((c) => ({ ...c, names: null }));
  return clauses.map((c) => (c.names && c.names.length > MAX_NAMED_PATHS ? { ...c, names: null } : c));
}

/** One clause as text: "read 3 files", "read loop.ts and constants.ts", "read the terminal 2 times". */
export function clauseText(c: Clause, capitalize = false): string {
  let text: string;
  if (c.names) text = `${c.verb} ${c.names.join(' and ')}`;
  else if (c.noun === TERMINAL_NOUN)
    text = c.count === 1 ? `${c.verb} ${c.noun}` : `${c.verb} ${c.noun} ${c.count} times`;
  else text = `${c.verb} ${c.count} ${c.noun}`;
  return capitalize ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function stepLabel(block: ToolBlock, tense: 'present' | 'past'): string {
  const arg = summarizeArgs(block.call.argsJson);
  const present = tense === 'present';
  let verb: string;
  switch (block.call.name) {
    case 'read_file':
      verb = present ? 'Reading' : 'Read';
      break;
    case 'search':
      verb = present ? 'Searching' : 'Searched';
      break;
    case 'list_files':
      verb = present ? 'Listing' : 'Listed';
      break;
    case 'edit_file':
      verb = present ? 'Editing' : 'Edited';
      break;
    case 'write_file':
      verb = present ? 'Writing' : 'Wrote';
      break;
    case 'delete_file':
      verb = present ? 'Deleting' : 'Deleted';
      break;
    case 'read_terminal':
      return present ? 'Reading the terminal…' : 'Read the terminal';
    default:
      return `${present ? 'Running' : 'Ran'} ${block.call.name}${present ? '…' : ''}`;
  }
  return `${verb}${arg ? ` ${arg}` : ''}${present ? '…' : ''}`;
}

/** The present-tense running step; between sequential calls, the last finished call in the past tense. */
function currentStep(blocks: ToolBlock[]): string {
  const running = blocks.find((b) => b.state === 'running');
  if (running) return stepLabel(running, 'present');
  const finished = blocks.findLast((b) => b.state === 'ok' || b.state === 'failed');
  if (finished) return stepLabel(finished, 'past');
  const queued = blocks.find((b) => b.state === 'queued');
  return queued ? stepLabel(queued, 'present') : 'Working…';
}

export function summarizeGroup(group: ToolGroupItem): GroupSummary {
  const { blocks } = group;
  const failed = blocks.filter((b) => b.state === 'failed').length;
  const notRun = blocks.filter((b) => b.state === 'skipped').length;
  const durationMs = blocks.reduce((sum, b) => sum + (b.result?.durationMs ?? 0), 0);
  // While live, the clauses cover only the calls that already finished; the current step leads the header.
  const counted = group.live ? blocks.filter((b) => b.state === 'ok' || b.state === 'failed') : blocks;
  const clauses = buildClauses(counted);
  const current = group.live ? currentStep(blocks) : null;

  const suffix = `${failed ? ` · ${failed} failed` : ''}${notRun ? ` · ${notRun} not run` : ''}`;
  const parts = clauses.map((c, i) => clauseText(c, !group.live && i === 0));
  const label = parts.join(', ');
  const text = group.live ? `${current}${label ? ` · ${label}` : ''}${suffix}` : `${label}${suffix}`;

  return {
    text,
    clauses,
    current,
    failed,
    notRun,
    durationMs,
    state: group.live ? 'live' : failed > 0 ? 'failed' : 'ok',
  };
}
