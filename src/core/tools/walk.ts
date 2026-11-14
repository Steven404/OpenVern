// Shared project walker (plan S3.3/S3.8): breadth-first, sorted, honours ignore rules, the deny list and abort.

import { constants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import { ALWAYS_SKIPPED_DIRS, IgnoreScope } from './ignore';
import { isDeniedEntryName, isInsideOpenVernDataDir, isOpenVernDataDir, isWithinAny } from './sandbox';

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
  /** Real absolute directories that are never entered or yielded (the app's data dir, S1-M1). */
  deniedRoots?: readonly string[];
  /** Extra deny rule over the root-relative POSIX path; matching entries are never yielded or entered. */
  isDeniedRel?: (relPosix: string) => boolean;
}

const isSmallRegularFile = (st: Stats): boolean => st.isFile() && st.size <= LIMITS.gitignoreMaxBytes;

/**
 * Reads `<dirAbs>/.gitignore` only if it is a regular file of at most `gitignoreMaxBytes` (S3-M1).
 * Never follows a symlink and never blocks on a FIFO or device; oversize files are skipped whole, not truncated.
 */
async function readGitignore(dirAbs: string, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return null;
  const p = path.join(dirAbs, '.gitignore');
  try {
    if (!isSmallRegularFile(await lstat(p))) return null;
    // Re-check on the open handle: O_NOFOLLOW fails a swapped-in symlink (ELOOP), O_NONBLOCK keeps a
    // swapped-in FIFO from blocking open(). Both are undefined on Windows, where the lstat check remains.
    const fh = await open(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      if (!isSmallRegularFile(await fh.stat())) return null;
      const buf = Buffer.alloc(LIMITS.gitignoreMaxBytes + 1);
      let n = 0;
      while (n < buf.length) {
        const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
        if (bytesRead === 0) break;
        n += bytesRead;
      }
      if (n > LIMITS.gitignoreMaxBytes) return null; // grew past the cap since the stat
      return buf.toString('utf8', 0, n);
    } finally {
      await fh.close();
    }
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

/** The `.gitignore` scope for the children of `dirAbs`: `parent` plus its own `.gitignore`, if `dirents` lists one. */
async function scopeOf(
  dirAbs: string,
  rel: string,
  dirents: readonly Dirent[],
  parent: IgnoreScope,
  signal: AbortSignal,
): Promise<IgnoreScope> {
  if (!dirents.some((d) => d.name === '.gitignore' && d.isFile())) return parent;
  const content = await readGitignore(dirAbs, signal);
  return content === null ? parent : parent.with(rel, content);
}

type FilterOptions = Pick<WalkOptions, 'root' | 'deniedRoots' | 'isDeniedRel'>;

/** The kind the walker yields the directory entry `d` (at root-relative `rel`) as, or null when it is left out. */
async function admittedKind(
  d: Dirent,
  rel: string,
  scope: IgnoreScope,
  opts: FilterOptions,
): Promise<WalkEntry['kind'] | null> {
  const kind = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : d.isFile() ? 'file' : null;
  if (kind === null) return null;
  if (kind === 'dir' && ALWAYS_SKIPPED_DIRS.has(d.name)) return null;
  if (isDeniedEntryName(d.name)) return null;
  if (opts.isDeniedRel?.(rel)) return null;
  // Every kind, not only dirs: a denied root may be a file (the target of a symlinked `~/.netrc`, say).
  if (isWithinAny(opts.deniedRoots, path.join(opts.root, rel))) return null;
  if (kind === 'dir' && (await isOpenVernDataDir(path.join(opts.root, rel)))) return null;
  if (scope.ignores(rel, kind === 'dir')) return null;
  return kind;
}

/** The walker's guards on its start directory (and so on the root of a full walk). */
async function startAllowed(opts: FilterOptions, startRel: string): Promise<boolean> {
  // `root` is real and the walker never follows symlinks, so `path.join(root, rel)` is a real path.
  if (isWithinAny(opts.deniedRoots, path.join(opts.root, startRel))) return false;
  if (startRel !== '' && opts.isDeniedRel?.(startRel)) return false;
  return !(await isInsideOpenVernDataDir(opts.root, path.join(opts.root, startRel)));
}

/**
 * The kind a full walk from the root (`startRel: ''`, unlimited depth) would yield `rel` as, or null when it never
 * would: a segment is missing (exact spelling, as `readdir` reports it), is a symlink or not a directory, or is left
 * out by the always-skipped dirs, the deny list, `isDeniedRel`, `deniedRoots`, a data dir or a `.gitignore`. Applies
 * the walker's own per-entry filter one segment at a time, so it can't drift from what a walk shows. `rel` is a
 * root-relative POSIX path without `.`/`..`/empty segments; `''` is the root and is checked like a walk's start.
 * A `readdir` error on a directory along the way is thrown (the caller decides how to report it).
 */
export async function walkedKind(
  opts: FilterOptions & { signal: AbortSignal },
  rel: string,
): Promise<WalkEntry['kind'] | null> {
  if (!(await startAllowed(opts, ''))) return null;
  if (rel === '') return 'dir';
  const segments = rel.split('/');
  let scope = IgnoreScope.empty;
  let parentRel = '';
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i] as string;
    const dirAbs = path.join(opts.root, parentRel);
    const dirents = await readdir(dirAbs, { withFileTypes: true });
    scope = await scopeOf(dirAbs, parentRel, dirents, scope, opts.signal);
    const d = dirents.find((x) => x.name === name);
    if (!d) return null;
    const childRel = parentRel === '' ? name : `${parentRel}/${name}`;
    const kind = await admittedKind(d, childRel, scope, opts);
    if (kind === null) return null;
    if (i === segments.length - 1) return kind;
    if (kind !== 'dir') return null;
    parentRel = childRel;
  }
  return null;
}

/**
 * Yields entries level by level (each directory's children sorted: directories first, then by name).
 * Symlinks are yielded as `symlink` and never followed. A `.gitignore` is read only if it is a regular file of at
 * most `LIMITS.gitignoreMaxBytes`; symlinked or special `.gitignore` files are ignored. Stops quietly when `signal` aborts; callers that
 * need to tell the difference check `signal.aborted` afterwards.
 */
export async function* walk(opts: WalkOptions): AsyncGenerator<WalkEntry> {
  const { root, startRel, maxDepth, signal } = opts;
  if (!(await startAllowed(opts, startRel))) return;

  // `.gitignore` files of the start directory's ancestors apply to everything below it.
  let scope = IgnoreScope.empty;
  const segments = startRel === '' ? [] : startRel.split('/');
  for (let i = 0; i < segments.length; i++) {
    const base = segments.slice(0, i).join('/');
    // `readGitignore` does the regular-file check (lstat), so a symlinked or special ancestor file is skipped.
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

    const local = await scopeOf(dirAbs, item.rel, dirents, item.scope, signal);

    const children: WalkEntry[] = [];
    for (const d of dirents) {
      const rel = item.rel === '' ? d.name : `${item.rel}/${d.name}`;
      const kind = await admittedKind(d, rel, local, opts);
      if (kind !== null) children.push({ rel, name: d.name, kind, depth: item.depth });
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
