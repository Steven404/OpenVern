// Read-only project file browsing for the Files panel (v0.2 plan §4.7, G3.1).
// Uses the tools' walker, ignore rules, deny list and sandbox, so the panel never shows or reads what the agent can't.

import { open, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import type { HomeFileTree, ProjectFileContent, ProjectFileEntry, ProjectFileTree } from '@shared/types';
import { CoreError } from '../errors';
import { resolveInProject, type SandboxOptions } from '../tools/sandbox';
import { walk } from '../tools/walk';
import type { ProjectFilesService, ProjectsService } from '../types';

const BINARY_SNIFF_BYTES = 8 * 1024;

export interface ProjectFilesDeps extends SandboxOptions {
  projects: Pick<ProjectsService, 'get'>;
  /** Root for `homeTree` / `homeRead`. Defaults to `os.homedir()`. */
  homeDir?: string;
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

  async function resolveFileAt(rootPath: string, relPath: string) {
    const res = await resolveInProject(rootPath, relPath, sandbox);
    if (!res.ok) throw new CoreError('invalid_request', res.message);
    if (!res.exists) throw new CoreError('not_found', `File not found: ${relPath}`);
    const info = await stat(res.abs);
    if (!info.isFile()) throw new CoreError('invalid_request', `${relPath} is not a file.`);
    return { abs: res.abs, rel: res.rel, size: info.size };
  }

  async function listTree(rootPath: string, signal?: AbortSignal): Promise<ProjectFileTree & { root: string }> {
    let root: string;
    try {
      root = await realpath(rootPath);
    } catch {
      throw new CoreError('path_invalid');
    }
    const entries: ProjectFileEntry[] = [];
    let truncated = false;
    for await (const e of walk({
      root,
      startRel: '',
      maxDepth: Number.MAX_SAFE_INTEGER,
      signal: signal ?? new AbortController().signal,
      deniedRoots: deps.deniedRoots,
    })) {
      if (e.kind === 'symlink') continue; // never followed, so nothing to show
      if (entries.length >= LIMITS.fileTreeMaxEntries) {
        truncated = true;
        break;
      }
      entries.push({ path: e.rel, type: e.kind });
    }
    return { root, entries: sortDepthFirst(entries), truncated };
  }

  async function readAt(rootPath: string, relPath: string): Promise<ProjectFileContent> {
    const { abs, rel, size } = await resolveFileAt(rootPath, relPath);
    const fh = await open(abs, 'r');
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

  async function readBytesAt(rootPath: string, relPath: string) {
    const { abs, size } = await resolveFileAt(rootPath, relPath);
    if (size > LIMITS.imageAttachmentBytes) throw new CoreError('file_too_large');
    return { name: path.basename(abs), bytes: new Uint8Array(await readFile(abs)) };
  }

  return {
    async tree(projectId, signal) {
      const project = await deps.projects.get(projectId);
      const listed = await listTree(project.rootPath, signal);
      return { entries: listed.entries, truncated: listed.truncated };
    },

    read(projectId, relPath) {
      return deps.projects.get(projectId).then((project) => readAt(project.rootPath, relPath));
    },

    readBytes(projectId, relPath) {
      return deps.projects.get(projectId).then((project) => readBytesAt(project.rootPath, relPath));
    },

    async homeTree(signal): Promise<HomeFileTree> {
      return listTree(homeDir(), signal);
    },

    homeRead(relPath) {
      return readAt(homeDir(), relPath);
    },

    homeReadBytes(relPath) {
      return readBytesAt(homeDir(), relPath);
    },
  };
}
