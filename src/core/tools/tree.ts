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
  /** Proposed edits (plan G2.3): created files are listed, deleted files hidden. Project-relative POSIX paths. */
  overlay?: { created: readonly string[]; deleted: ReadonlySet<string> };
}

function compareEntries(a: WalkEntry, b: WalkEntry): number {
  const aDir = a.kind === 'dir' ? 0 : 1;
  const bDir = b.kind === 'dir' ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Entries (files plus the directories above them) that `created` adds below `startRel` within `depth` levels. */
function overlayEntries(startRel: string, depth: number, created: readonly string[], known: Set<string>): WalkEntry[] {
  const prefix = startRel === '' ? '' : `${startRel}/`;
  const out: WalkEntry[] = [];
  for (const file of created) {
    if (!file.startsWith(prefix)) continue;
    const parts = file.slice(prefix.length).split('/');
    let rel = startRel;
    for (let i = 0; i < parts.length && i < depth; i++) {
      const name = parts[i] as string;
      rel = rel === '' ? name : `${rel}/${name}`;
      if (known.has(rel)) continue;
      known.add(rel);
      out.push({ rel, name, kind: i === parts.length - 1 ? 'file' : 'dir', depth: i + 1 });
    }
  }
  return out;
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
    if (opts.overlay?.deleted.has(entry.rel)) continue;
    if (entries.length >= opts.maxEntries) {
      truncated = true;
      break;
    }
    entries.push(entry);
  }
  if (opts.signal.aborted) return { lines: [], shown: 0, truncated, aborted: true };
  if (opts.overlay && opts.overlay.created.length > 0) {
    const extra = overlayEntries(startRel, opts.depth, opts.overlay.created, new Set(entries.map((e) => e.rel)));
    for (const e of extra) {
      if (entries.length >= opts.maxEntries) {
        truncated = true;
        break;
      }
      entries.push(e);
    }
  }

  const children = new Map<string, WalkEntry[]>();
  for (const entry of entries) {
    const parent = parentOf(entry.rel);
    const list = children.get(parent);
    if (list) list.push(entry);
    else children.set(parent, [entry]);
  }

  if (opts.overlay) for (const list of children.values()) list.sort(compareEntries);

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
