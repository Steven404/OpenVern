// ProjectsService (plan S1.5): `projects.json`.

import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Id, Project, ProjectListItem } from '@shared/types';
import { accessDeniedError, CoreError } from '../errors';
import type { ChatsService, ProjectsService } from '../types';
import { JsonFile, type StorageLogger } from './json-file';
import { expandHome } from './paths';
import { type ProjectsFile, projectsFileSchema } from './schemas';

export interface ProjectsServiceOptions {
  /** Absolute path of `projects.json`. */
  filePath: string;
  /** Used for `chatCount` and to re-home chats when a project is removed. */
  chats: Pick<ChatsService, 'list' | 'detachProject'>;
  logger?: StorageLogger;
  /** Real path of the data dir. Roots equal to it or inside it are rejected (S1-M1); roots containing it are fine. */
  dataDir?: string;
  /** Picks the macOS access-denial messages (AS-08). Defaults to process.platform; tests inject it. */
  platform?: NodeJS.Platform;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Expands `~`, requires an absolute path (S1-N1: never resolved against the cwd), resolves to a realpath and
 * checks it is a readable directory outside the data dir. Throws `path_invalid`.
 */
async function resolveProjectRoot(
  input: string,
  dataDir?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const invalid = () => new CoreError('path_invalid');
  const expanded = expandHome(input.trim());
  if (!expanded) throw invalid();
  if (!path.isAbsolute(expanded)) throw new CoreError('path_invalid', 'Enter an absolute path to a folder.');
  try {
    const real = await fs.realpath(expanded);
    if (dataDir && isInside(dataDir, real)) {
      throw new CoreError('path_invalid', 'This folder is inside the app data folder and cannot be a project.');
    }
    if (!(await fs.stat(real)).isDirectory()) throw invalid();
    await fs.access(real, constants.R_OK | constants.X_OK);
    return real;
  } catch (err) {
    if (err instanceof CoreError) throw err;
    throw accessDeniedError(err, 'folder', platform) ?? invalid();
  }
}

/** A `.git` file is one short line; anything much larger isn't one. */
const GITFILE_MAX_BYTES = 64 * 1024;

/**
 * Whether the `.git` file at `file` (a linked worktree or a submodule) still points at a repository. It must read
 * `gitdir: <path>` (a relative path counts from the folder that holds the file), and that path must be a directory with
 * a `HEAD` file. Without this check a worktree whose repository was deleted would still count as in Git, and Auto would
 * be turned on there without the no-Git warning. Anything malformed or unreadable is false: it fails closed.
 */
async function gitfilePointsAtRepo(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > GITFILE_MAX_BYTES) return false;
    const match = /^gitdir: ([^\r\n]+)\r?(?:\n|$)/.exec(await fs.readFile(file, 'utf8'));
    const target = match?.[1];
    if (!target) return false;
    const gitDir = path.resolve(path.dirname(file), target);
    if (!(await fs.stat(gitDir)).isDirectory()) return false;
    return (await fs.stat(path.join(gitDir, 'HEAD'))).isFile();
  } catch {
    return false;
  }
}

/**
 * True when the nearest `.git` in `root` or one of its ancestors is a repository: a `.git` directory, or a `.git` file
 * (worktrees and submodules use one) that points at an existing git dir. Git itself stops at the nearest `.git`, so a
 * broken `.git` file is false rather than a reason to keep looking upward. An error while looking for `.git` counts as
 * "not found" for that folder, so an unreadable ancestor never throws. Never runs `git`.
 */
export async function inGitRepo(root: string): Promise<boolean> {
  let dir = root;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const found = await fs.lstat(dotGit).then(
      () => true,
      () => false,
    );
    if (found) {
      // Followed, so a link to a repository counts as before; a dangling link is broken, not "not found".
      const stat = await fs.stat(dotGit).catch(() => null);
      if (stat?.isDirectory()) return true;
      return stat?.isFile() ? gitfilePointsAtRepo(dotGit) : false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

const byName = (a: Project, b: Project) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.createdAt.localeCompare(b.createdAt);

export function createProjectsService(opts: ProjectsServiceOptions): ProjectsService {
  const file = new JsonFile<ProjectsFile>(opts.filePath, projectsFileSchema, { logger: opts.logger });

  const all = async (): Promise<Project[]> => (await file.read())?.projects ?? [];
  const mutate = (fn: (projects: Project[]) => Project[]) =>
    file.update((cur) => ({ version: 1, projects: fn(cur?.projects ?? []) }));

  const find = async (id: Id): Promise<Project> => {
    const project = (await all()).find((p) => p.id === id);
    if (!project) throw new CoreError('not_found', 'Project not found.');
    return project;
  };

  return {
    async list(): Promise<ProjectListItem[]> {
      const [projects, chats] = await Promise.all([all(), opts.chats.list()]);
      const counts = new Map<Id, number>();
      for (const chat of chats) {
        if (chat.projectId) counts.set(chat.projectId, (counts.get(chat.projectId) ?? 0) + 1);
      }
      const sorted = projects.sort(byName);
      // Computed on every list (never stored): a folder can gain or lose its repository at any time.
      const git = await Promise.all(sorted.map((p) => inGitRepo(p.rootPath)));
      return sorted.map((p, i) => ({ ...p, chatCount: counts.get(p.id) ?? 0, inGitRepo: git[i] ?? false }));
    },

    get: find,

    async create(input) {
      const rootPath = await resolveProjectRoot(input.rootPath, opts.dataDir, opts.platform);
      const name = input.name?.trim() || path.basename(rootPath) || rootPath;
      const project: Project = { id: randomUUID(), name, rootPath, createdAt: new Date().toISOString() };
      // The duplicate check runs inside the file lock, so two concurrent adds cannot both succeed.
      await file.update((cur) => {
        const projects = cur?.projects ?? [];
        if (projects.some((p) => p.rootPath === rootPath)) {
          throw new CoreError('conflict', 'This folder has already been added as a project.');
        }
        return { version: 1, projects: [...projects, project] };
      });
      return project;
    },

    async rename(id, name) {
      const trimmed = name.trim();
      if (!trimmed) throw new CoreError('invalid_request', 'The project name is empty.');
      let renamed: Project | undefined;
      await mutate((projects) =>
        projects.map((p) => {
          if (p.id !== id) return p;
          renamed = { ...p, name: trimmed };
          return renamed;
        }),
      );
      if (!renamed) throw new CoreError('not_found', 'Project not found.');
      return renamed;
    },

    async remove(id) {
      await find(id);
      // Re-home chats first: a crash in between leaves a harmless orphan project, never dangling chats.
      await opts.chats.detachProject(id);
      await mutate((projects) => projects.filter((p) => p.id !== id));
    },
  };
}
