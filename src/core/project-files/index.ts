// Read-only project file browsing for the Files panel (v0.2 plan §4.7, G3.1).
// Uses the tools' walker, ignore rules, deny list and sandbox, so the panel never shows or reads what the agent can't.
// The home folder (chats without a project) adds a home-only deny layer (`home-deny.ts`: top-level dotfiles, app-data
// folders, credential folders at any depth, symlinked targets of those) and rejects hardlinked files.

import { type FileHandle, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import type { HomeFileTree, ProjectFileContent, ProjectFileEntry, ProjectFileTree } from '@shared/types';
import { accessDeniedError, CoreError } from '../errors';
import {
  BLOCKED_MESSAGE,
  isInsideOpenVernDataDir,
  isWithinAny,
  resolveInProject,
  type SandboxOptions,
} from '../tools/sandbox';
import { walk } from '../tools/walk';
import type { ProjectFilesService, ProjectsService } from '../types';
import { homeSymlinkDeniedRoots, isHomeDeniedRel } from './home-deny';

const BINARY_SNIFF_BYTES = 8 * 1024;

type FileOptions = SandboxOptions & {
  /** Reject regular files with more than one link (a hardlink can alias a denied file under an allowed name). */
  rejectHardlinks?: boolean;
};

export interface ProjectFilesDeps extends SandboxOptions {
  projects: Pick<ProjectsService, 'get'>;
  /** Root for `homeTree` / `homeRead`. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Picks the macOS access-denial handling (AS-08). Defaults to process.platform; tests inject it. */
  platform?: NodeJS.Platform;
}

const byName = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** Depth-first order: within a directory, dirs first, then case-insensitive name. */
function sortDepthFirst(entries: ProjectFileEntry[]): ProjectFileEntry[] {
  const children = new Map<string, ProjectFileEntry[]>();
  for (const e of entries) {
    const i = e.path.lastIndexOf('/');
    const parent = i === -1 ? '' : e.path.slice(0, i);
    const list = children.get(parent);
    if (list) list.push(e);
    else children.set(parent, [e]);
  }
  const out: ProjectFileEntry[] = [];
  const emit = (dir: string): void => {
    const list = children.get(dir);
    if (!list) return;
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return byName(a.path, b.path);
    });
    for (const e of list) {
      out.push(e);
      if (e.type === 'dir') emit(e.path);
    }
  };
  emit('');
  return out;
}

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

  async function listTree(
    rootPath: string,
    opts: FileOptions,
    signal?: AbortSignal,
  ): Promise<ProjectFileTree & { root: string }> {
    let root: string;
    try {
      root = await realpath(rootPath);
    } catch (err) {
      throw accessDeniedError(err, 'folder', platform) ?? new CoreError('path_invalid');
    }
    const abort = signal ?? new AbortController().signal;
    const entries: ProjectFileEntry[] = [];
    let truncated = false;
    for await (const e of walk({
      root,
      startRel: '',
      maxDepth: Number.MAX_SAFE_INTEGER,
      signal: abort,
      deniedRoots: opts.deniedRoots,
      isDeniedRel: opts.isDeniedRel,
    })) {
      if (e.kind === 'symlink') continue; // never followed, so nothing to show
      if (entries.length >= LIMITS.fileTreeMaxEntries) {
        truncated = true;
        break;
      }
      entries.push({ path: e.rel, type: e.kind });
    }
    if (entries.length === 0 && platform === 'darwin' && !abort.aborted) await assertRootListable(root, opts);
    return { root, entries: sortDepthFirst(entries), truncated };
  }

  /**
   * darwin only (AS-08). The walker skips a root it can't read (walk.ts:104-108), so a macOS privacy denial would list
   * as an empty project. Repeats the walker's own root call, only where the walker made it (its root guards,
   * walk.ts:82-84), and turns EPERM/EACCES into an actionable error. Any other error keeps today's empty tree.
   */
  async function assertRootListable(root: string, opts: FileOptions): Promise<void> {
    if (isWithinAny(opts.deniedRoots, root) || (await isInsideOpenVernDataDir(root, root))) return;
    try {
      await readdir(root, { withFileTypes: true }); // result discarded: nothing is listed from here
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
    async tree(projectId, signal) {
      const project = await deps.projects.get(projectId);
      const listed = await listTree(project.rootPath, sandbox, signal);
      return { entries: listed.entries, truncated: listed.truncated };
    },

    read(projectId, relPath) {
      return deps.projects.get(projectId).then((project) => readAt(project.rootPath, relPath, sandbox));
    },

    readBytes(projectId, relPath) {
      return deps.projects.get(projectId).then((project) => readBytesAt(project.rootPath, relPath, sandbox));
    },

    async homeTree(signal): Promise<HomeFileTree> {
      return listTree(homeDir(), await homeSandbox(), signal);
    },

    async homeRead(relPath) {
      return readAt(homeDir(), relPath, await homeSandbox());
    },

    async homeReadBytes(relPath) {
      return readBytesAt(homeDir(), relPath, await homeSandbox());
    },
  };
}
