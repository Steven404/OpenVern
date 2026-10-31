// Shared project walker (plan S3.3/S3.8): breadth-first, sorted, honours ignore rules, the deny list and abort.

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ALWAYS_SKIPPED_DIRS, IgnoreScope } from './ignore';
import { isDeniedEntryName } from './sandbox';

export interface WalkEntry {
  /** Project-relative POSIX path. */
  rel: string;
  name: string;
  kind: 'dir' | 'file' | 'symlink';
  /** 1 for direct children of the start directory. */
  depth: number;
}

export interface WalkOptions {
  /** Real absolute project root. */
  root: string;
  /** Directory to start from, project-relative POSIX path (`''` = root). Not itself subject to ignore rules. */
  startRel: string;
  /** Entries deeper than this are not visited. */
  maxDepth: number;
  signal: AbortSignal;
}

async function readGitignore(dirAbs: string, signal: AbortSignal): Promise<string | null> {
  try {
    return await readFile(path.join(dirAbs, '.gitignore'), { encoding: 'utf8', signal });
  } catch {
    return null;
  }
}

function compareEntries(a: WalkEntry, b: WalkEntry): number {
  const aDir = a.kind === 'dir' ? 0 : 1;
  const bDir = b.kind === 'dir' ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Yields entries level by level (each directory's children sorted: directories first, then by name).
 * Symlinks are yielded as `symlink` and never followed. Stops quietly when `signal` aborts; callers that
 * need to tell the difference check `signal.aborted` afterwards.
 */
export async function* walk(opts: WalkOptions): AsyncGenerator<WalkEntry> {
  const { root, startRel, maxDepth, signal } = opts;

  // `.gitignore` files of the start directory's ancestors apply to everything below it.
  let scope = IgnoreScope.empty;
  const segments = startRel === '' ? [] : startRel.split('/');
  for (let i = 0; i < segments.length; i++) {
    const base = segments.slice(0, i).join('/');
    const content = await readGitignore(path.join(root, base), signal);
    if (content !== null) scope = scope.with(base, content);
  }

  const queue: { rel: string; depth: number; scope: IgnoreScope }[] = [{ rel: startRel, depth: 1, scope }];
  for (let head = 0; head < queue.length; head++) {
    if (signal.aborted) return;
    const item = queue[head];
    if (!item) continue;
    const dirAbs = path.join(root, item.rel);

    let dirents: Dirent[];
    try {
      dirents = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      continue; // unreadable or vanished: skip
    }

    let local = item.scope;
    if (dirents.some((d) => d.name === '.gitignore' && !d.isDirectory())) {
      const content = await readGitignore(dirAbs, signal);
      if (content !== null) local = local.with(item.rel, content);
    }

    const children: WalkEntry[] = [];
    for (const d of dirents) {
      const kind = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : d.isFile() ? 'file' : null;
      if (kind === null) continue;
      if (kind === 'dir' && ALWAYS_SKIPPED_DIRS.has(d.name)) continue;
      if (isDeniedEntryName(d.name)) continue;
      const rel = item.rel === '' ? d.name : `${item.rel}/${d.name}`;
      if (local.ignores(rel, kind === 'dir')) continue;
      children.push({ rel, name: d.name, kind, depth: item.depth });
    }
    children.sort(compareEntries);

    for (const entry of children) {
      yield entry;
      if (entry.kind === 'dir' && item.depth < maxDepth) {
        queue.push({ rel: entry.rel, depth: item.depth + 1, scope: local });
      }
    }
  }
}
