// /projects*

import { attachProjectFileBody, createProjectBody, ROUTES, renameProjectBody } from '@shared/api';
import { Hono } from 'hono';
import { CoreError } from '../../core/errors';
import type { Core } from '../../core/types';
import { readJson } from '../http';

export function projectRoutes(core: Core): Hono {
  const r = new Hono();

  r.get(ROUTES.projects, async (c) => c.json(await core.projects.list()));

  r.post(ROUTES.projects, async (c) => {
    const body = await readJson(c, createProjectBody);
    return c.json(await core.projects.create(body));
  });

  r.patch(ROUTES.project, async (c) => {
    const { name } = await readJson(c, renameProjectBody);
    return c.json(await core.projects.rename(c.req.param('id'), name));
  });

  r.get(ROUTES.projectFiles, async (c) => c.json(await core.projectFiles.tree(c.req.param('id'), c.req.raw.signal)));

  r.get(ROUTES.projectFileContent, async (c) => {
    const p = c.req.query('path');
    if (!p) throw new CoreError('invalid_request', 'Missing "path" query parameter.');
    return c.json(await core.projectFiles.read(c.req.param('id'), p));
  });

  r.post(ROUTES.projectFileAttach, async (c) => {
    const { path } = await readJson(c, attachProjectFileBody);
    const file = await core.projectFiles.readBytes(c.req.param('id'), path);
    return c.json(await core.attachments.create(file));
  });

  r.get(ROUTES.homeFiles, async (c) => c.json(await core.projectFiles.homeTree(c.req.raw.signal)));

  r.get(ROUTES.homeFileContent, async (c) => {
    const p = c.req.query('path');
    if (!p) throw new CoreError('invalid_request', 'Missing "path" query parameter.');
    return c.json(await core.projectFiles.homeRead(p));
  });

  r.post(ROUTES.homeFileAttach, async (c) => {
    const { path } = await readJson(c, attachProjectFileBody);
    const file = await core.projectFiles.homeReadBytes(path);
    return c.json(await core.attachments.create(file));
  });

  r.delete(ROUTES.project, async (c) => {
    const id = c.req.param('id');
    // §3.2: removing a project discards its chats' pending edits (they move to "Chats" and could never be applied).
    for (const chat of await core.chats.list()) {
      if (chat.projectId !== id) continue;
      if ((await core.changes.get(chat.id)).pending) await core.changes.discard(chat.id);
    }
    await core.projects.remove(id);
    return c.body(null, 204);
  });

  return r;
}
