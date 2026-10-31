// ProjectsService (plan S1.5): `projects.json`.

import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Id, Project, ProjectListItem } from '@shared/types';
import { CoreError } from '../errors';
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
}

/** Expands `~`, resolves to a realpath and checks it is a readable directory. Throws `path_invalid`. */
async function resolveProjectRoot(input: string): Promise<string> {
  const invalid = () => new CoreError('path_invalid');
  const expanded = expandHome(input.trim());
  if (!expanded) throw invalid();
  try {
    const real = await fs.realpath(path.resolve(expanded));
    if (!(await fs.stat(real)).isDirectory()) throw invalid();
    await fs.access(real, constants.R_OK | constants.X_OK);
    return real;
  } catch (err) {
    throw err instanceof CoreError ? err : invalid();
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
      return projects.sort(byName).map((p) => ({ ...p, chatCount: counts.get(p.id) ?? 0 }));
    },

    get: find,

    async create(input) {
      const rootPath = await resolveProjectRoot(input.rootPath);
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
