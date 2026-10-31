// Path sandbox + secret deny list (plan S3.1, S3.2). Every tool resolves user-supplied paths through here.

import { realpath } from 'node:fs/promises';
import path from 'node:path';

export const OUTSIDE_MESSAGE = 'Path is outside the project';
export const BLOCKED_MESSAGE = 'Access to this file is blocked';

const SAFE_ENV_NAMES = new Set(['.env.example', '.env.sample']);

/** True when a single path segment names a secret-looking file (or the `.git` internals). */
function isDeniedName(name: string): boolean {
  const n = name.toLowerCase();
  if (n === '.git') return true;
  if (n === '.env') return true;
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

function toPosix(rel: string): string {
  return path.sep === '/' ? rel : rel.split(path.sep).join('/');
}

/**
 * Resolves `relPath` against the project root. Rejects `..` escapes, absolute paths outside the root and
 * symlinks whose real path leaves the root, then applies the deny list to both the lexical and the real path.
 */
export async function resolveInProject(root: string, relPath: string): Promise<ResolveResult> {
  if (relPath.includes('\0')) return { ok: false, kind: 'invalid', message: 'Invalid path (contains a NUL byte)' };

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, kind: 'invalid', message: 'The project folder is not accessible' };
  }

  const lexicalRoot = path.resolve(root);
  let abs = path.resolve(lexicalRoot, relPath === '' ? '.' : relPath);
  // Absolute paths spelled through a symlinked root (e.g. /tmp -> /private/tmp) are mapped onto the real root.
  if (lexicalRoot !== realRoot && isInside(lexicalRoot, abs)) {
    abs = path.join(realRoot, path.relative(lexicalRoot, abs));
  }
  if (!isInside(realRoot, abs)) return { ok: false, kind: 'outside', message: OUTSIDE_MESSAGE };
  if (isDeniedPath(path.relative(realRoot, abs))) return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };

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
  if (isDeniedPath(rel)) return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };
  return { ok: true, abs: real, rel, root: realRoot, exists };
}
