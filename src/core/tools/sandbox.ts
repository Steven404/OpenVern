// Path sandbox + secret deny list (plan S3.1, S3.2). Every tool resolves user-supplied paths through here.

import type { Stats } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const OUTSIDE_MESSAGE = 'Path is outside the project';
export const BLOCKED_MESSAGE = 'Access to this file is blocked';

const SAFE_ENV_NAMES = new Set(['.env.example', '.env.sample']);

/** True when a single path segment names a secret-looking file (or the `.git` internals). */
function isDeniedName(name: string): boolean {
  const n = name.toLowerCase();
  if (n === '.git') return true;
  if (n === '.env') return true;
  // Another openvern instance's data dir (dev builds use `.dev-data`) and the key file every data dir holds.
  if (n === '.dev-data' || n.startsWith('.dev-data-')) return true;
  if (n === 'secrets.json') return true;
  if (n.startsWith('.env.') && !SAFE_ENV_NAMES.has(n)) return true;
  if (n.endsWith('.pem') || n.endsWith('.key') || n.endsWith('.p12')) return true;
  if (n.startsWith('id_rsa') || n.startsWith('id_ed25519') || n.startsWith('id_ecdsa') || n.startsWith('id_dsa')) {
    return true;
  }
  if (n === '.git-credentials' || n === '.netrc' || n === '_netrc') return true;
  return false;
}

/** Deny list over a project-relative path: any segment that matches blocks the whole path. */
export function isDeniedPath(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((segment) => segment !== '' && isDeniedName(segment));
}

/** Deny check for one directory entry name (used by the walker). */
export function isDeniedEntryName(name: string): boolean {
  return isDeniedName(name);
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * True when `dirAbs` looks like a openvern data dir (see `dataPaths`): it has `chats/index.json` AND at least one of
 * `projects.json`, `settings.json`, `secrets.json`. `chats/index.json` is written on the first chat, and a chat needs a
 * project, so every dir that holds conversations has both; a fresh dir (nothing sensitive yet) has neither. A
 * bare `chats/` folder in an ordinary repo has no such sibling file. Costs one `lstat` for ordinary directories.
 */
export async function isOpenVernDataDir(dirAbs: string): Promise<boolean> {
  if (!(await isFile(path.join(dirAbs, 'chats', 'index.json')))) return false;
  for (const f of ['projects.json', 'settings.json', 'secrets.json']) {
    if (await isFile(path.join(dirAbs, f))) return true;
  }
  return false;
}

/** True when `dirAbs` or any directory between `realRoot` (inclusive) and it is a openvern data dir. */
export async function isInsideOpenVernDataDir(realRoot: string, dirAbs: string): Promise<boolean> {
  const parts = path.relative(realRoot, dirAbs).split(path.sep).filter(Boolean);
  let cur = realRoot;
  if (await isOpenVernDataDir(cur)) return true;
  for (const part of parts) {
    cur = path.join(cur, part);
    if (await isOpenVernDataDir(cur)) return true;
  }
  return false;
}

export type ResolveResult =
  | {
      ok: true;
      /** Absolute real path (symlinks resolved). */
      abs: string;
      /** Real path relative to the real project root, POSIX separators, `''` for the root itself. */
      rel: string;
      /** Real project root (symlinks resolved). */
      root: string;
      /** False when the path does not exist (it is still guaranteed to lie inside the project). */
      exists: boolean;
    }
  | { ok: false; kind: 'outside' | 'blocked' | 'invalid'; message: string };

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** True when `target` is one of `roots` or lies below one. Compares absolute paths, never names. */
export function isWithinAny(roots: readonly string[] | undefined, target: string): boolean {
  return roots?.some((r) => isInside(r, target)) ?? false;
}

export interface SandboxOptions {
  /**
   * Real absolute paths no tool may reach, even when they lie inside the project (the app's data dir, S1-M1).
   * Matched by real path only: a folder that merely shares the name is not affected.
   */
  deniedRoots?: readonly string[];
  /**
   * Absolute paths of files no tool may read under another name (the app's `secrets.json`, plan K1). Only hardlinks
   * can alias a file to an allowed name once symlinks are resolved, so this is checked only for files with `nlink > 1`,
   * against the denied file's current inode.
   */
  deniedFiles?: readonly string[];
  /**
   * Extra deny rule over the root-relative POSIX path (`''` for the root itself), applied to both the lexical and the
   * real path. Used for the home folder's deny layer, which projects don't share.
   */
  isDeniedRel?: (relPosix: string) => boolean;
}

/** True when `info` (a regular file with more than one link) is the same inode as one of `deniedFiles`. */
export async function isDeniedHardlink(info: Stats, deniedFiles: readonly string[] | undefined): Promise<boolean> {
  if (!deniedFiles?.length || !info.isFile() || info.nlink < 2) return false;
  for (const f of deniedFiles) {
    try {
      const d = await stat(f);
      if (d.ino === info.ino && d.dev === info.dev) return true;
    } catch {
      // A denied file that does not exist cannot be aliased.
    }
  }
  return false;
}

function toPosix(rel: string): string {
  return path.sep === '/' ? rel : rel.split(path.sep).join('/');
}

/**
 * Resolves `relPath` against the project root. Rejects `..` escapes, absolute paths outside the root and
 * symlinks whose real path leaves the root, then applies the deny list and `deniedRoots` to both the lexical and
 * the real path. A root that itself lies inside a denied root blocks everything.
 */
export async function resolveInProject(
  root: string,
  relPath: string,
  opts: SandboxOptions = {},
): Promise<ResolveResult> {
  const { deniedRoots } = opts;
  if (relPath.includes('\0')) return { ok: false, kind: 'invalid', message: 'Invalid path (contains a NUL byte)' };

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, kind: 'invalid', message: 'The project folder is not accessible' };
  }
  if (isWithinAny(deniedRoots, realRoot)) return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };

  const lexicalRoot = path.resolve(root);
  let abs = path.resolve(lexicalRoot, relPath === '' ? '.' : relPath);
  // Absolute paths spelled through a symlinked root (e.g. /tmp -> /private/tmp) are mapped onto the real root.
  if (lexicalRoot !== realRoot && isInside(lexicalRoot, abs)) {
    abs = path.join(realRoot, path.relative(lexicalRoot, abs));
  }
  if (!isInside(realRoot, abs)) return { ok: false, kind: 'outside', message: OUTSIDE_MESSAGE };
  if (
    isDeniedPath(path.relative(realRoot, abs)) ||
    isWithinAny(deniedRoots, abs) ||
    opts.isDeniedRel?.(toPosix(path.relative(realRoot, abs)))
  ) {
    return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };
  }

  let real = abs;
  let exists = true;
  try {
    real = await realpath(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') exists = false;
    else return { ok: false, kind: 'invalid', message: `Cannot access path: ${code ?? 'unknown error'}` };
  }
  if (!isInside(realRoot, real)) return { ok: false, kind: 'outside', message: OUTSIDE_MESSAGE };
  const rel = toPosix(path.relative(realRoot, real));
  if (isDeniedPath(rel) || isWithinAny(deniedRoots, real) || opts.isDeniedRel?.(rel)) {
    return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };
  }
  // The real path (or a directory above it) may be a data dir of any name; ancestors only, to keep the cost bounded.
  if (await isInsideOpenVernDataDir(realRoot, exists ? real : path.dirname(real))) {
    return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };
  }
  if (exists && opts.deniedFiles?.length) {
    const info = await lstat(real).catch(() => null);
    if (info && (await isDeniedHardlink(info, opts.deniedFiles))) {
      return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };
    }
  }
  return { ok: true, abs: real, rel, root: realRoot, exists };
}

/**
 * Like `resolveInProject`, for a path an edit tool will write (plan G2.2). A path that doesn't exist yet is only
 * accepted when its nearest existing ancestor is a directory that resolves inside the root (not through a symlink
 * that leaves it) and passes the deny list. `rel` then names the path below that real ancestor.
 */
export async function resolveForWrite(
  root: string,
  relPath: string,
  opts: SandboxOptions = {},
): Promise<ResolveResult> {
  const res = await resolveInProject(root, relPath, opts);
  if (!res.ok || res.exists) return res;

  // Walk up the lexical path to the nearest ancestor that exists, and resolve that one through the sandbox.
  const missing: string[] = [];
  let probe = res.rel;
  for (;;) {
    const slash = probe.lastIndexOf('/');
    missing.unshift(probe.slice(slash + 1));
    probe = slash === -1 ? '' : probe.slice(0, slash);
    const anc = await resolveInProject(root, probe, opts);
    if (!anc.ok) return anc;
    if (!anc.exists) continue;
    const info = await lstat(anc.abs).catch(() => null);
    if (!info?.isDirectory()) {
      return { ok: false, kind: 'invalid', message: `Cannot create ${res.rel}: ${anc.rel || '.'} is not a directory` };
    }
    const rel = [anc.rel, ...missing].filter(Boolean).join('/');
    if (isDeniedPath(rel) || opts.isDeniedRel?.(rel)) return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };
    return { ok: true, abs: path.join(anc.abs, ...missing), rel, root: anc.root, exists: false };
  }
}
