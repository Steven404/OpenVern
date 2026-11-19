// /projects*

import { attachProjectFileBody, createProjectBody, REMOVE_WHILE_RUNNING, ROUTES, renameProjectBody } from '@shared/api';
import { Hono } from 'hono';
import { CoreError } from '../../core/errors';
import type { Core } from '../../core/types';
import { readJson } from '../http';
import { runClaims } from './chats';

export function projectRoutes(core: Core): Hono {
  const r = new Hono();
  const claims = runClaims(core);

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
    // NO PROJECT CHANGE DURING A TURN (invariant, see `RunClaims`): removing a project moves its chats to "Chats", so
    // it is refused (409, nothing changed) while a turn runs or is starting in any of them. The hold is taken first,
    // synchronously, and kept until `projects.remove` has returned: from then on no turn starts in a chat of this
    // project (a turn start reads the chat under its claim and is refused when its project is being removed). So
    // the check below covers every chat the removal detaches, here or in `projects.remove`'s fallback: a chat listed
    // here was idle when checked and can't start a turn after it, and a chat that moves in later was idle when its
    // move was checked and can't start one once it is in.
    const releaseRemoval = claims.holdRemoval(id);
    try {
      const chats = (await core.chats.list()).filter((chat) => chat.projectId === id);
      if (chats.some((chat) => claims.turnActive(chat.id))) throw new CoreError('conflict', REMOVE_WHILE_RUNNING);
      // Removing a project discards its chats' pending edits (they move to "Chats" and could never be applied). Each
      // chat is discarded and detached together under its change-store lock (`changeProject`), so a detach can't
      // land between Apply's project check and its writes, and a stage can't add proposals between the discard and
      // the detach, and `changeProject` then resets the chat's per-project Auto state (open batches closed, reads
      // cleared). `projects.remove` then detaches any chat that joined the project since the list, as before; that
      // path skips the reset, and batches, reads and proposals stay apart because each is bound to its project.
      for (const chat of chats) {
        // LOCK ORDER: the chat's change-store lock (`changeProject`), then the chat storage lock (`chats.update`),
        // then the chat file's lock (inside it).
        // A project change never happens while a turn runs (the check and the hold above), so a turn's writes stay in
        // one batch per project; the reset in `changeProject` and the turn's pinned project remain as defence in depth.
        await core.changes.changeProject(chat.id, async ({ pending, discard }) => {
          const current = await core.chats.get(chat.id).catch((err) => {
            if (err instanceof CoreError && err.code === 'not_found') return null;
            throw err;
          });
          // Moved away (or removed) since the list: not this project's chat any more.
          if (current?.projectId !== id) return;
          if (pending) await discard();
          // A chat deleted between the read above and this update is already gone from the project: that must not
          // abort the removal halfway, after other chats were detached and their proposals discarded.
          await core.chats.update(chat.id, { projectId: null }).catch((err) => {
            if (err instanceof CoreError && err.code === 'not_found') return;
            throw err;
          });
        });
      }
      await core.projects.remove(id);
    } finally {
      releaseRemoval();
    }
    return c.body(null, 204);
  });

  return r;
}
