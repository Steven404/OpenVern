// /projects*

import { createProjectBody, ROUTES, renameProjectBody } from '@shared/api';
import { Hono } from 'hono';
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

  r.delete(ROUTES.project, async (c) => {
    await core.projects.remove(c.req.param('id'));
    return c.body(null, 204);
  });

  return r;
}
