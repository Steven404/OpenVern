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

  // `?path=` is one folder (root-relative POSIX, default the root); only its direct children are returned.
  r.get(ROUTES.projectFiles, async (c) =>
    c.json(await core.projectFiles.list(c.req.param('id'), c.req.query('path') ?? '', c.req.raw.signal)),
  );

  r.get(ROUTES.projectFileSearch, async (c) =>
    c.json(await core.projectFiles.search(c.req.param('id'), c.req.query('q') ?? '', c.req.raw.signal)),
  );

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

  r.get(ROUTES.homeFiles, async (c) =>
    c.json(await core.projectFiles.homeList(c.req.query('path') ?? '', c.req.raw.signal)),
  );

  r.get(ROUTES.homeFileSearch, async (c) =>
    c.json(await core.projectFiles.homeSearch(c.req.query('q') ?? '', c.req.raw.signal)),
  );

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
    await core.projects.get(id); // 404 before any chat is touched
    // Removing a project discards its chats' pending edits (they move to "Chats" and could never be applied). Each
    // chat is discarded and detached together under its change-store lock (`changeProject`), so a detach can't land
    // between Apply's project check and its writes, and a stage can't add proposals between the discard and the
    // detach. `projects.remove` then detaches any chat that joined the project since the list, as before.
    for (const chat of await core.chats.list()) {
      if (chat.projectId !== id) continue;
      // LOCK ORDER: the chat's change-store lock (`changeProject`), then the chat storage lock (`chats.update`).
      await core.changes.changeProject(chat.id, async ({ pending, discard }) => {
        const current = await core.chats.get(chat.id).catch((err) => {
          if (err instanceof CoreError && err.code === 'not_found') return null;
          throw err;
        });
        // Moved away (or removed) since the list: not this project's chat any more.
        if (current?.projectId !== id) return;
        if (pending) await discard();
        // A chat deleted between the read above and this update is already gone from the project: that must not abort
        // the removal halfway, after other chats were detached and their proposals discarded.
        await core.chats.update(chat.id, { projectId: null }).catch((err) => {
          if (err instanceof CoreError && err.code === 'not_found') return;
          throw err;
        });
      });
    }
    await core.projects.remove(id);
    return c.body(null, 204);
  });

  return r;
}
