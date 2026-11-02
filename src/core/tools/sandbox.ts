// Path sandbox + secret deny list (plan S3.1, S3.2). Every tool resolves user-supplied paths through here.

import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const OUTSIDE_MESSAGE = 'Path is outside the project';
export const BLOCKED_MESSAGE = 'Access to this file is blocked';

const SAFE_ENV_NAMES = new Set(['.env.example', '.env.sample']);

/** True when a single path segment names a secret-looking file (or the `.git` internals). */
function isDeniedName(name: string): boolean {
  const n = name.toLowerCase();
  if (n === '.git') return true;
  if (n === '.env') return true;
  // Another harness instance's data dir (dev builds use `.dev-data`) and the key file every data dir holds.
  if (n === '.dev-data' || n.startsWith('.dev-data-')) return true;
  if (n === 'secrets.json') return true;
  if (n.startsWith('.env.') && !SAFE_ENV_NAMES.has(n)) return true;
  if (n.endsWith('.pem') || n.endsWith('.key') || n.endsWith('.p12')) return true;
  if (n.startsWith('id_rsa') || n.startsWith('id_ed25519')) return true;
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
 * True when `dirAbs` looks like a harness data dir (see `dataPaths`): it has `chats/index.json` AND at least one of
 * `projects.json`, `settings.json`, `secrets.json`. `chats/index.json` is written on the first chat, and a chat needs a
 * project, so every dir that holds conversations has both; a fresh dir (nothing sensitive yet) has neither. A
 * bare `chats/` folder in an ordinary repo has no such sibling file. Costs one `lstat` for ordinary directories.
 */
export async function isHarnessDataDir(dirAbs: string): Promise<boolean> {
  if (!(await isFile(path.join(dirAbs, 'chats', 'index.json')))) return false;
  for (const f of ['projects.json', 'settings.json', 'secrets.json']) {
    if (await isFile(path.join(dirAbs, f))) return true;
  }
  return false;
}

/** True when `dirAbs` or any directory between `realRoot` (inclusive) and it is a harness data dir. */
export async function isInsideHarnessDataDir(realRoot: string, dirAbs: string): Promise<boolean> {
  const parts = path.relative(realRoot, dirAbs).split(path.sep).filter(Boolean);
  let cur = realRoot;
  if (await isHarnessDataDir(cur)) return true;
  for (const part of parts) {
    cur = path.join(cur, part);
    if (await isHarnessDataDir(cur)) return true;
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
  if (isDeniedPath(path.relative(realRoot, abs)) || isWithinAny(deniedRoots, abs)) {
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
  if (isDeniedPath(rel) || isWithinAny(deniedRoots, real)) {
    return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };
  }
  // The real path (or a directory above it) may be a data dir of any name; ancestors only, to keep the cost bounded.
  if (await isInsideHarnessDataDir(realRoot, exists ? real : path.dirname(real))) {
    return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };
  }
  return { ok: true, abs: real, rel, root: realRoot, exists };
}
