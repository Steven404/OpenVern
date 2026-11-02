// Indented directory tree shared by `list_files` and the system-prompt project tree (plan S3.4, S3.8).

import { realpath } from 'node:fs/promises';
import { isWithinAny } from './sandbox';
import { type WalkEntry, walk } from './walk';

export interface TreeListing {
  /** Indented lines, directories suffixed `/`, symlinks suffixed `@`. Empty when the directory is empty. */
  lines: string[];
  shown: number;
  /** True when more entries exist than `maxEntries`. */
  truncated: boolean;
  aborted: boolean;
}

export interface TreeOptions {
  depth: number;
  maxEntries: number;
  signal: AbortSignal;
  /** Forwarded to `walk`: real absolute directories that are never listed. */
  deniedRoots?: readonly string[];
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/**
 * Lists `startRel` (project-relative, `''` = root) down to `depth` levels. Shallow entries are preferred when
 * the listing is truncated, so the top of the project is always visible.
 */
export async function buildTree(root: string, startRel: string, opts: TreeOptions): Promise<TreeListing> {
  const entries: WalkEntry[] = [];
  let truncated = false;
  for await (const entry of walk({
    root,
    startRel,
    maxDepth: opts.depth,
    signal: opts.signal,
    deniedRoots: opts.deniedRoots,
  })) {
    if (entries.length >= opts.maxEntries) {
      truncated = true;
      break;
    }
    entries.push(entry);
  }
  if (opts.signal.aborted) return { lines: [], shown: 0, truncated, aborted: true };

  const children = new Map<string, WalkEntry[]>();
  for (const entry of entries) {
    const parent = parentOf(entry.rel);
    const list = children.get(parent);
    if (list) list.push(entry);
    else children.set(parent, [entry]);
  }

  const lines: string[] = [];
  const render = (dir: string, indent: number): void => {
    for (const entry of children.get(dir) ?? []) {
      const suffix = entry.kind === 'dir' ? '/' : entry.kind === 'symlink' ? '@' : '';
      lines.push(`${'  '.repeat(indent)}${entry.name}${suffix}`);
      if (entry.kind === 'dir') render(entry.rel, indent + 1);
    }
  };
  render(startRel, 0);
  return { lines, shown: entries.length, truncated, aborted: false };
}

export function truncationNote(shown: number): string {
  return `... truncated: showing the first ${shown} entries (shallowest first). List a subdirectory or use a smaller depth to see more.`;
}

/** Tree of the project for the system prompt (plan S3.8). Never throws. */
export async function renderTree(
  root: string,
  opts: { depth: number; maxEntries: number; deniedRoots?: readonly string[]; signal?: AbortSignal },
): Promise<string> {
  try {
    const realRoot = await realpath(root);
    if (isWithinAny(opts.deniedRoots, realRoot)) return '(empty)';
    const tree = await buildTree(realRoot, '', { ...opts, signal: opts.signal ?? new AbortController().signal });
    if (tree.aborted) return '(aborted)';
    if (tree.lines.length === 0) return '(empty)';
    return tree.truncated ? [...tree.lines, truncationNote(tree.shown)].join('\n') : tree.lines.join('\n');
  } catch {
    return '(project folder is not readable)';
  }
}
