// Path sandbox + secret deny list (plan S3.1, S3.2). Every tool resolves user-supplied paths through here.

import { existsSync, lstatSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const OUTSIDE_MESSAGE = 'Path is outside the project';
export const BLOCKED_MESSAGE = 'Access to this file is blocked';

const SAFE_ENV_NAMES = new Set(['.env.example', '.env.sample']);

/** The deny rules over one spelling of a segment (lower-cased, or folded by `foldSegment`). */
function matchesDenyRule(n: string): boolean {
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

/**
 * True when a single path segment names a secret-looking file (or the `.git` internals). The rules see the segment
 * lower-cased. On darwin a segment that isn't printable ASCII is also checked in its `foldSegment` spelling, because
 * APFS stores an alias such as `secretſ.json` as the same name as `secrets.json`. The lower-case check runs first and
 * is kept, so the fold only adds denials: the `.env.example` / `.env.sample` exceptions apply per spelling, and a name
 * the lower-case check denies (`.env.ｅxample`) stays denied even when it folds to an allowed one. Other platforms
 * match the lower-cased spelling only.
 */
function isDeniedName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return (
    matchesDenyRule(name.toLowerCase()) ||
    (platform === 'darwin' && !PRINTABLE_ASCII.test(name) && matchesDenyRule(foldSegment(name)))
  );
}

/** Deny list over a project-relative path: any segment that matches blocks the whole path. */
export function isDeniedPath(relPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return relPath.split(/[\\/]/).some((segment) => segment !== '' && isDeniedName(segment, platform));
}

/** Deny check for one directory entry name (used by the walker): the rule `isDeniedPath` applies to each segment. */
export function isDeniedEntryName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return isDeniedName(name, platform);
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

const PRINTABLE_ASCII = /^[ -~]*$/;
const MARKS = /\p{M}/gu;

/**
 * Conservative fold of one path segment, for darwin deny matching. It is deliberately coarser than the volume:
 * compatibility decomposition (NFKD), full case folding with expansions (upper- then lower-casing, so `ß`/`ẞ` -> `ss`,
 * `ﬀ` -> `ff`, `ſ` -> `s`; final `ς` -> `σ`), and combining marks dropped, repeated to a fixed point. It is not an
 * emulation of APFS. Measured on macOS APFS (each assigned, non-private code point and its case and decomposition
 * images), it merges every pair the volume stores as one name, and it also merges names APFS keeps apart (`ö`/`o`,
 * `ｏ`/`o`): over-denial of such look-alike paths is the accepted fail-safe tradeoff. Printable ASCII folds to its
 * lowercase.
 */
function foldSegment(segment: string): string {
  if (PRINTABLE_ASCII.test(segment)) return segment.toLowerCase();
  let cur = segment;
  for (let i = 0; i < 4; i++) {
    const next = cur
      .normalize('NFKD')
      .toUpperCase()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/ς/g, 'σ')
      .replace(MARKS, '');
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * True when two project-relative POSIX paths are the same up to letter case or Unicode form: NFC plus lower case on
 * every platform, and on darwin also segment by segment through `foldSegment` (`poſt.txt` matches `post.txt`,
 * `straße.txt` matches `strasse.txt`; like the fold, it can also match look-alikes the volume keeps apart). It only
 * picks a message; it never decides a denial.
 */
export function sameFoldedRel(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()) return true;
  if (platform !== 'darwin') return false;
  const aFolded = a.split('/').map(foldSegment);
  const bFolded = b.split('/').map(foldSegment);
  return aFolded.length === bFolded.length && aFolded.every((s, i) => s === bFolded[i]);
}

/** Folded segments of an absolute path. Folding happens per segment, so it can never add separators or `..` steps. */
const foldedSegments = (p: string): string[] => path.resolve(p).split(path.sep).filter(Boolean).map(foldSegment);

const startsWithSegments = (root: readonly string[], target: readonly string[]): boolean =>
  root.length <= target.length && root.every((s, i) => s === target[i]);

/**
 * Firmlink sources of the macOS system volume, as listed in `/usr/share/firmlinks` (macOS 26.6, read 2026-11-10), each
 * the same directory as that path below `/System/Volumes/Data`. Folded once at load (after `foldSegment`'s constants);
 * the file is never read at runtime.
 */
const FIRMLINK_SOURCES: readonly (readonly string[])[] = [
  '/AppleInternal',
  '/Applications',
  '/Library',
  '/System/Library/Caches',
  '/System/Library/Assets',
  '/System/Library/PreinstalledAssets',
  '/System/Library/AssetsV2',
  '/System/Library/PreinstalledAssetsV2',
  '/System/Library/CoreServices/CoreTypes.bundle/Contents/Library',
  '/System/Library/Speech',
  '/Users',
  '/Volumes',
  '/cores',
  '/opt',
  '/pkg',
  '/private',
  '/usr/local',
  '/usr/libexec/cups',
  '/usr/share/snmp',
].map((p) => p.split('/').filter(Boolean).map(foldSegment));

/** Folded segments of the data volume's mount point, `/System/Volumes/Data`. */
const DATA_VOLUME: readonly string[] = ['system', 'volumes', 'data'];

/**
 * The firmlink short form of an absolute path's folded segments: `system/volumes/data/<source>/…` becomes
 * `<source>/…` when the rest starts, segment by segment, with a firmlink source. Anything else comes back unchanged
 * (other `/System/Volumes/*` paths, a rest that isn't firmlinked, `DataX`, `Users2`, `usr/localx`). It strips once at
 * most, from the front only, so it never adds a segment and never removes the last one.
 */
function firmlinkShortForm(segments: readonly string[]): readonly string[] {
  if (!startsWithSegments(DATA_VOLUME, segments)) return segments;
  const rest = segments.slice(DATA_VOLUME.length);
  return FIRMLINK_SOURCES.some((source) => startsWithSegments(source, rest)) ? rest : segments;
}

/**
 * Symlinks `resolveBelow` follows by hand: more than one path lookup follows (32 on macOS), so it reaches every
 * destination a lookup can.
 */
const MAX_ROOT_LINKS = 40;

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/** `lstat`, or null when `p` is missing or can't be inspected (`ENOENT` costs no exception; `ENOTDIR`, `EACCES` do). */
function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

function readlinkOrNull(p: string): string | null {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolves `segments` below the real directory `base` one at a time, as a lookup (or the `mkdir` of the missing part)
 * would: a symlink, dangling or not, is replaced by its `readlink` destination (relative to the real directory holding
 * it, so `..` applies after the link is resolved), and once a segment is missing the rest is kept as spelled, a `..`
 * then cancelling the missing segment before it. A segment that can't be inspected, or a link past `MAX_ROOT_LINKS`
 * (a loop), is kept as spelled too. Bounded: each step consumes one queued segment, and only a followed link (at most
 * `MAX_ROOT_LINKS`, each at most one `readlink` long) queues more. The result is absolute and contains no `.`/`..`.
 */
function resolveBelow(realBase: string, segments: readonly string[]): string {
  const queue = [...segments];
  const missing: string[] = [];
  let base = realBase;
  let real = true;
  let links = 0;
  for (let seg = queue.shift(); seg !== undefined; seg = queue.shift()) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (missing.length > 0) missing.pop();
      else base = path.dirname(base);
      continue;
    }
    if (missing.length > 0) {
      missing.push(seg);
      continue;
    }
    const next = path.join(base, seg);
    const info = lstatOrNull(next);
    if (info?.isSymbolicLink() && links < MAX_ROOT_LINKS) {
      const dest = readlinkOrNull(next);
      if (dest !== null) {
        links++;
        if (path.isAbsolute(dest)) {
          base = path.parse(dest).root;
          real = true;
        }
        queue.unshift(...dest.split(path.sep));
        continue;
      }
    }
    if (info === null || info.isSymbolicLink()) {
      missing.push(seg);
    } else {
      // Not a link, so `path.dirname` of it stays exact for a later `..`; the stored spelling is read once at the end.
      base = next;
      real = false;
    }
  }
  return path.join((real ? base : realpathOrNull(base)) ?? base, ...missing);
}

/**
 * Where `root` is, or would be created, now: the realpath of its nearest ancestor that `existsSync` sees (live
 * symlinks such as `/tmp` -> `/private/tmp`, and the stored spelling of case or Unicode aliases, resolved), then the
 * segments below it through `resolveBelow`, which follows a dangling symlink (the root itself, or an ancestor, linked
 * to a destination that doesn't exist yet) to that destination and keeps the missing rest. Synchronous because the
 * walker's per-entry check is; read at every call, never cached, so a root or link created after the policy was built
 * is seen (a change racing the check is not). Anything that can't be resolved stays as spelled; the lexical root is
 * matched separately, so this only adds a spelling to deny.
 */
function canonicalRoot(root: string): string {
  const rest: string[] = [];
  let cur = path.resolve(root);
  for (;;) {
    // `existsSync` doesn't throw, so the usual missing levels cost no exception.
    const real = existsSync(cur) ? realpathOrNull(cur) : null;
    if (real !== null) return rest.length === 0 ? real : resolveBelow(real, rest);
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(root);
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

/**
 * True when `canonicalRoot(root)` must end in `root`'s own last segment (as spelled, or as the alias stored on disk),
 * found with one `lstat` per missing level. Walking up from `root` to the deepest path `lstat` can see: if that is
 * `root` and not a symlink, the canonical root is its realpath, whose last segment is the stored spelling of `root`'s;
 * if it is an ancestor that is a real entry or a live symlink, every segment below is missing at its resolved place
 * and kept as spelled. Only a symlink standing in for the root (the root itself, or a dangling or looping ancestor
 * link) can give the canonical root another last segment, and then this is false.
 */
function keepsLastSegment(root: string): boolean {
  const resolved = path.resolve(root);
  for (let cur = resolved; ; cur = path.dirname(cur)) {
    const info = lstatOrNull(cur);
    if (info !== null) return !info.isSymbolicLink() || (cur !== resolved && existsSync(cur));
    if (path.dirname(cur) === cur) return false;
  }
}

/**
 * True when `target` is one of `roots` or lies below one. Compares absolute paths, never names. The exact check comes
 * first and is the only one on other platforms. On darwin (APFS and HFS+ are case- and normalization-insensitive by
 * default) a root also matches when, segment by segment, its `foldSegment` spelling or that of its `canonicalRoot`
 * contains the target's: a root kept lexically because it didn't exist (AS-05) may sit below a symlink, be a dangling
 * symlink itself, or be spelled as an alias. Every extra branch only adds denials; folding also applies on
 * case-sensitive APFS, where a distinct `OPENVERN` next to a denied `openvern` is over-denied (accepted fail-safe).
 *
 * `realpath` keeps a `/System/Volumes/Data/<firmlink source>/…` spelling, while the system volume shows the same
 * directory as `/<source>/…`, so on darwin the folded root (and its `canonicalRoot`) is also compared with the target
 * in their `firmlinkShortForm`s: a root and a target spelled the two ways match in either direction. That is lexical,
 * with no extra I/O. Not covered: a long-spelled root above a firmlink source (`/System/Volumes/Data` itself, or
 * `/System/Volumes/Data/System/Library`) against short targets below that source. The roots production passes are
 * app data folders, not such system directories.
 *
 * `canonicalRoot` costs a `realpath`, so it is skipped only when `keepsLastSegment` shows the canonical root must end
 * in the root's own last segment and the target has no segment folding like it (then the target can't be inside). The
 * short forms keep the last segment, and the target's is a suffix of the target, so the skip covers them too.
 */
export function isWithinAny(
  roots: readonly string[] | undefined,
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!roots?.length) return false;
  if (roots.some((r) => isInside(r, target))) return true;
  if (platform !== 'darwin') return false;
  const t = foldedSegments(target);
  const tShort = firmlinkShortForm(t);
  for (const r of roots) {
    const folded = foldedSegments(r);
    if (startsWithSegments(folded, t) || startsWithSegments(firmlinkShortForm(folded), tShort)) return true;
    const last = folded[folded.length - 1];
    if (last !== undefined && !t.includes(last) && keepsLastSegment(r)) continue;
    const canonical = canonicalRoot(r);
    const canonicalFolded = foldedSegments(canonical);
    if (
      isInside(canonical, target) ||
      startsWithSegments(canonicalFolded, t) ||
      startsWithSegments(firmlinkShortForm(canonicalFolded), tShort)
    ) {
      return true;
    }
  }
  return false;
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
    // The real ancestor plus the missing segments is the path the write would create: re-check `deniedRoots` on it
    // (the lexical check above can't see a root reached through a symlink or another spelling of an ancestor).
    const abs = path.join(anc.abs, ...missing);
    if (isDeniedPath(rel) || isWithinAny(opts.deniedRoots, abs) || opts.isDeniedRel?.(rel)) {
      return { ok: false, kind: 'blocked', message: BLOCKED_MESSAGE };
    }
    return { ok: true, abs, rel, root: anc.root, exists: false };
  }
}
