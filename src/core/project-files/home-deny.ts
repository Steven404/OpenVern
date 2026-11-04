// Home-folder deny layer for the Files panel of chats without a project. On top of the shared sandbox deny list it
// hides top-level dotfiles and OS app-data folders of `~`, and credential folders at any depth. Projects don't use it:
// a repo legitimately holds `.npmrc`, `.docker/` and the like.

import type { Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Top-level dot entries of `~` that stay visible. Empty for now: shell rc files (`.bashrc`, `.zshrc`, ...) often hold
 * API keys, so no dotfile is shown by default.
 */
export const HOME_ALLOWED_TOP: ReadonlySet<string> = new Set<string>();

/** Top-level (non-dot) folders of `~` that hold app data, keychains and browser profiles (lowercased). */
export const HOME_DENIED_TOP: ReadonlySet<string> = new Set(['library', 'appdata', 'snap']);

/** Segment names denied at any depth below `~` (lowercased), e.g. `~/dotfiles/ssh/.ssh/config`. */
export const HOME_DENIED_ANYWHERE: ReadonlySet<string> = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.password-store',
  '.mozilla',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.vault-token',
  '.git-credentials',
]);

function isDeniedTop(segment: string): boolean {
  if (segment.startsWith('.')) return !HOME_ALLOWED_TOP.has(segment);
  return HOME_DENIED_TOP.has(segment);
}

/** True when the home-relative POSIX path `rel` is hidden by the home deny layer. `''` (home itself) is allowed. */
export function isHomeDeniedRel(rel: string): boolean {
  if (rel === '') return false;
  const segments = rel
    .split('/')
    .filter((s) => s !== '')
    .map((s) => s.toLowerCase());
  const first = segments[0];
  if (first === undefined) return false;
  if (isDeniedTop(first)) return true;
  return segments.some((s) => HOME_DENIED_ANYWHERE.has(s));
}

/**
 * Real paths of the targets of denied top-level entries of `realHome` that are symlinks (`~/.aws -> dotfiles/aws`),
 * so the sandbox and walker hide the target under its real name too. Read fresh on every call; errors are ignored
 * (a dangling or unreadable link has nothing to hide). A target that is `realHome` itself or one of its ancestors is
 * skipped: denying it would block the whole home folder, and the link's own name is already denied.
 */
export async function homeSymlinkDeniedRoots(realHome: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(realHome, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const d of entries) {
    if (!d.isSymbolicLink() || !isHomeDeniedRel(d.name)) continue;
    try {
      const target = await realpath(path.join(realHome, d.name));
      const up = path.relative(target, realHome);
      const containsHome = up === '' || (up !== '..' && !up.startsWith(`..${path.sep}`) && !path.isAbsolute(up));
      if (!containsHome) roots.push(target);
    } catch {
      // Dangling or unreadable: nothing to hide.
    }
  }
  return roots;
}
