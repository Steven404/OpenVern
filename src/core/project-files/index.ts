// Read-only project file browsing for the Files panel (v0.2 plan §4.7, G3.1).
// Uses the tools' walker, ignore rules, deny list and sandbox, so the panel never shows or reads what the agent can't.
// The panel lists one folder at a time (`list`, the folder's direct children) and filters with a capped server-side
// search (`search`). The folder comes from the client, so it is checked against what a full walk from the root would
// show (`resolveListedDir`) before anything is listed: a folder the walk would never enter is never listed either.
// The home folder (chats without a project) adds a home-only deny layer (`home-deny.ts`: top-level dotfiles, app-data
// folders, credential folders at any depth, symlinked targets of those) and rejects hardlinked files.

import { type FileHandle, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import type {
  HomeFileListing,
  ProjectFileContent,
  ProjectFileEntry,
  ProjectFileListing,
  ProjectFileSearchResult,
} from '@shared/types';
import { accessDeniedError, CoreError } from '../errors';
import {
  BLOCKED_MESSAGE,
  isInsideOpenVernDataDir,
  isWithinAny,
  resolveInProject,
  type SandboxOptions,
} from '../tools/sandbox';
import { walk, walkedKind } from '../tools/walk';
import type { ProjectFilesService, ProjectsService } from '../types';
import { homeSymlinkDeniedRoots, isHomeDeniedRel } from './home-deny';

const BINARY_SNIFF_BYTES = 8 * 1024;

type FileOptions = SandboxOptions & {
  /** Reject regular files with more than one link (a hardlink can alias a denied file under an allowed name). */
  rejectHardlinks?: boolean;
};

export interface ProjectFilesDeps extends SandboxOptions {
  projects: Pick<ProjectsService, 'get'>;
  /** Root for `homeList` / `homeSearch` / `homeRead`. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Picks the macOS access-denial handling (AS-08). Defaults to process.platform; tests inject it. */
  platform?: NodeJS.Platform;
  /** Overrides for the listing and search caps (tests). Defaults to the `LIMITS` values. */
  limits?: Partial<FileLimits>;
}

interface FileLimits {
  folderMaxEntries: number;
  searchMaxResults: number;
  searchMaxScanned: number;
}

const byName = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** Folder order: dirs first, then case-insensitive name. */
const byEntry = (a: ProjectFileEntry, b: ProjectFileEntry): number => {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return byName(a.path, b.path);
};

function countLines(text: string): number {
  if (text === '') return 0;
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n : n + 1;
}

/** Drops a trailing incomplete multi-byte UTF-8 sequence (a cut at the size limit must not yield U+FFFD). */
function trimPartialUtf8(buf: Buffer): Buffer {
  for (let back = 1; back <= 4 && back <= buf.length; back++) {
    const b = buf[buf.length - back] as number;
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? buf.subarray(0, buf.length - back) : buf;
  }
  return buf;
}

export function createProjectFilesService(deps: ProjectFilesDeps): ProjectFilesService {
  const sandbox: SandboxOptions = { deniedRoots: deps.deniedRoots, deniedFiles: deps.deniedFiles };
  const homeDir = () => deps.homeDir ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const limits: FileLimits = {
    folderMaxEntries: LIMITS.fileTreeFolderMaxEntries,
    searchMaxResults: LIMITS.fileSearchMaxResults,
    searchMaxScanned: LIMITS.fileSearchMaxScanned,
    ...deps.limits,
  };

  /** Sandbox for the home folder, rebuilt per call so newly created symlinks are seen. */
  async function homeSandbox(): Promise<FileOptions> {
    let realHome: string;
    try {
      realHome = await realpath(homeDir());
    } catch {
      throw new CoreError('path_invalid');
    }
    return {
      deniedRoots: [...(deps.deniedRoots ?? []), ...(await homeSymlinkDeniedRoots(realHome))],
      deniedFiles: deps.deniedFiles,
      isDeniedRel: isHomeDeniedRel,
      rejectHardlinks: true,
    };
  }

  async function resolveFileAt(rootPath: string, relPath: string, opts: FileOptions) {
    const res = await resolveInProject(rootPath, relPath, opts);
    if (!res.ok) throw new CoreError('invalid_request', res.message);
    if (!res.exists) throw new CoreError('not_found', `File not found: ${relPath}`);
    const info = await stat(res.abs);
    if (!info.isFile()) throw new CoreError('invalid_request', `${relPath} is not a file.`);
    if (opts.rejectHardlinks && info.nlink > 1) throw new CoreError('invalid_request', BLOCKED_MESSAGE);
    return { abs: res.abs, rel: res.rel, size: info.size };
  }

  async function realRootOf(rootPath: string): Promise<string> {
    try {
      return await realpath(rootPath);
    } catch (err) {
      throw accessDeniedError(err, 'folder', platform) ?? new CoreError('path_invalid');
    }
  }

  /**
   * Validates a client-supplied folder (root-relative POSIX) before it is listed, and returns it. The panel must never
   * show what a full walk from the root would not, and `walk`'s `startRel` is itself exempt from the ignore rules and
   * from the per-segment checks, so this refuses, in order:
   * - anything the agent's sandbox refuses (`resolveInProject`, as `list_files` uses it): NUL bytes, `..` escapes and
   *   absolute paths outside the root, symlinks leaving it, deny-listed names, `deniedRoots`, a data dir, and the home
   *   deny layer: `invalid_request` with the sandbox's message;
   * - any spelling other than the canonical one the listing returns (`.`, `..`, empty segments, leading `/`):
   *   `invalid_request`;
   * - a folder that doesn't exist: `not_found`;
   * - a folder a full walk would never yield (`walkedKind`): a symlink anywhere along the path, an always-skipped dir
   *   (`node_modules`, ...), a `.gitignore`d dir, or a spelling that differs from the stored name: `not_found`, as the
   *   panel never shows it. `list_files` lets the agent list an ignored start directory; the panel deliberately doesn't;
   * - a file: `invalid_request`.
   * `''` (the root) is not checked here: the walker's own start guards apply, and a denied root lists as empty, as before.
   */
  async function resolveListedDir(root: string, dir: string, opts: FileOptions, signal: AbortSignal): Promise<string> {
    if (dir === '') return '';
    const res = await resolveInProject(root, dir, opts);
    if (!res.ok) throw new CoreError('invalid_request', res.message);
    if (dir.startsWith('/') || dir.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new CoreError('invalid_request', `Invalid folder path: ${dir}`);
    }
    const notFound = () => new CoreError('not_found', `Folder not found: ${dir}`);
    if (!res.exists) throw notFound();
    let kind: Awaited<ReturnType<typeof walkedKind>>;
    try {
      kind = await walkedKind({ root, deniedRoots: opts.deniedRoots, isDeniedRel: opts.isDeniedRel, signal }, dir);
    } catch (err) {
      throw accessDeniedError(err, 'folder', platform) ?? notFound();
    }
    if (kind === 'file') throw new CoreError('invalid_request', `${dir} is not a folder.`);
    if (kind !== 'dir') throw notFound();
    return dir;
  }

  async function listAt(
    rootPath: string,
    dir: string,
    opts: FileOptions,
    signal?: AbortSignal,
  ): Promise<ProjectFileListing & { root: string }> {
    const root = await realRootOf(rootPath);
    const abort = signal ?? new AbortController().signal;
    const rel = await resolveListedDir(root, dir, opts, abort);
    const entries: ProjectFileEntry[] = [];
    // One level: the walker reads the folder whole anyway, so collect it all, sort, then cut (a stable first page).
    for await (const e of walk({
      root,
      startRel: rel,
      maxDepth: 1,
      signal: abort,
      deniedRoots: opts.deniedRoots,
      isDeniedRel: opts.isDeniedRel,
    })) {
      if (e.kind === 'symlink') continue; // never followed, so nothing to show
      entries.push({ path: e.rel, type: e.kind });
    }
    if (entries.length === 0 && platform === 'darwin' && !abort.aborted) await assertListable(root, rel, opts);
    entries.sort(byEntry);
    const truncated = entries.length > limits.folderMaxEntries;
    return { root, path: rel, entries: truncated ? entries.slice(0, limits.folderMaxEntries) : entries, truncated };
  }

  async function searchAt(
    rootPath: string,
    query: string,
    opts: FileOptions,
    signal?: AbortSignal,
  ): Promise<ProjectFileSearchResult> {
    const q = query.trim().toLowerCase();
    if (q === '') throw new CoreError('invalid_request', 'Missing search text.');
    if (q.length > LIMITS.fileSearchMaxQueryLength)
      throw new CoreError('invalid_request', 'The search text is too long.');
    const root = await realRootOf(rootPath);
    const abort = signal ?? new AbortController().signal;
    const entries: ProjectFileEntry[] = [];
    let scanned = 0;
    let truncated: ProjectFileSearchResult['truncated'] = false;
    // Breadth-first walk order, so shallow matches come first; deterministic for a given tree.
    for await (const e of walk({
      root,
      startRel: '',
      maxDepth: Number.MAX_SAFE_INTEGER,
      signal: abort,
      deniedRoots: opts.deniedRoots,
      isDeniedRel: opts.isDeniedRel,
    })) {
      if (scanned >= limits.searchMaxScanned) {
        truncated = 'scanned';
        break;
      }
      scanned++;
      if (e.kind !== 'file' || !e.rel.toLowerCase().includes(q)) continue;
      if (entries.length >= limits.searchMaxResults) {
        truncated = 'results';
        break;
      }
      entries.push({ path: e.rel, type: 'file' });
    }
    if (abort.aborted)
      truncated = 'scanned'; // stopped part-way; nobody is waiting for the answer anyway
    else if (scanned === 0 && platform === 'darwin') await assertListable(root, '', opts);
    return { entries, truncated };
  }

  /**
   * darwin only (AS-08). The walker skips a folder it can't read (walk.ts, the `readdir` catch), so a macOS privacy
   * denial would list as an empty folder. Repeats the walker's own `readdir` of the listed folder, only where the
   * walker made it (its start guards), and turns EPERM/EACCES into an actionable error. Any other error keeps today's
   * empty listing.
   */
  async function assertListable(root: string, rel: string, opts: FileOptions): Promise<void> {
    const abs = path.join(root, rel);
    if (isWithinAny(opts.deniedRoots, abs) || (await isInsideOpenVernDataDir(root, abs))) return;
    try {
      await readdir(abs, { withFileTypes: true }); // result discarded: nothing is listed from here
    } catch (err) {
      const denied = accessDeniedError(err, 'folder', platform);
      if (denied) throw denied;
    }
  }

  async function readAt(rootPath: string, relPath: string, opts: FileOptions): Promise<ProjectFileContent> {
    const { abs, rel, size } = await resolveFileAt(rootPath, relPath, opts);
    let fh: FileHandle;
    try {
      fh = await open(abs, 'r');
    } catch (err) {
      throw accessDeniedError(err, 'file', platform) ?? err;
    }
    try {
      const want = Math.min(size, LIMITS.viewerMaxBytes);
      const buf = Buffer.alloc(want);
      let n = 0;
      while (n < want) {
        const { bytesRead } = await fh.read(buf, n, want - n, n);
        if (bytesRead === 0) break;
        n += bytesRead;
      }
      const data = buf.subarray(0, n);
      if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        return { path: rel, size, totalLines: 0, content: null, binary: true, truncated: false };
      }
      const truncated = size > LIMITS.viewerMaxBytes;
      const text = (truncated ? trimPartialUtf8(data) : data).toString('utf8');
      return { path: rel, size, totalLines: countLines(text), content: text, binary: false, truncated };
    } finally {
      await fh.close();
    }
  }

  async function readBytesAt(rootPath: string, relPath: string, opts: FileOptions) {
    const { abs, size } = await resolveFileAt(rootPath, relPath, opts);
    if (size > LIMITS.imageAttachmentBytes) throw new CoreError('file_too_large');
    let data: Buffer;
    try {
      data = await readFile(abs);
    } catch (err) {
      throw accessDeniedError(err, 'file', platform) ?? err;
    }
    return { name: path.basename(abs), bytes: new Uint8Array(data) };
  }

  return {
    async list(projectId, dir, signal) {
      const project = await deps.projects.get(projectId);
      const { root: _root, ...listed } = await listAt(project.rootPath, dir, sandbox, signal);
      return listed;
    },

    async search(projectId, query, signal) {
      const project = await deps.projects.get(projectId);
      return searchAt(project.rootPath, query, sandbox, signal);
    },

    read(projectId, relPath) {
      return deps.projects.get(projectId).then((project) => readAt(project.rootPath, relPath, sandbox));
    },

    readBytes(projectId, relPath) {
      return deps.projects.get(projectId).then((project) => readBytesAt(project.rootPath, relPath, sandbox));
    },

    async homeList(dir, signal): Promise<HomeFileListing> {
      return listAt(homeDir(), dir, await homeSandbox(), signal);
    },

    async homeSearch(query, signal) {
      return searchAt(homeDir(), query, await homeSandbox(), signal);
    },

    async homeRead(relPath) {
      return readAt(homeDir(), relPath, await homeSandbox());
    },

    async homeReadBytes(relPath) {
      return readBytesAt(homeDir(), relPath, await homeSandbox());
    },
  };
}
