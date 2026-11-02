// /chats* (CRUD + the two streaming routes)

import { applyChangesBody, createChatBody, ROUTES, retryBody, sendMessageBody, updateChatBody } from '@shared/api';
import { LIMITS } from '@shared/constants';
import type { Id } from '@shared/types';
import { Hono } from 'hono';
import { CoreError } from '../../core/errors';
import type { Core } from '../../core/types';
import { readJson } from '../http';
import { streamTurn } from '../sse';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits (bounded) for an aborted run to finish persisting, so we don't delete a chat under its feet. */
async function waitForIdle(core: Core, chatId: Id, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (core.agent.isRunning(chatId) && Date.now() < deadline) await sleep(10);
}

export function chatRoutes(core: Core): Hono {
  const r = new Hono();
  /** Chats whose run is being set up (validated, stream not yet started). Closes the check-then-run race. */
  const starting = new Set<Id>();

  /** Synchronous check-and-claim. Returns a once-only release function. */
  const claim = (chatId: Id): (() => void) => {
    if (starting.has(chatId) || core.agent.isRunning(chatId))
      throw new CoreError('conflict', 'A response is already being generated for this chat.');
    starting.add(chatId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      starting.delete(chatId);
    };
  };

  r.get(ROUTES.chats, async (c) => c.json(await core.chats.list()));

  r.post(ROUTES.chats, async (c) => {
    const body = await readJson(c, createChatBody);
    return c.json(await core.chats.create(body));
  });

  r.get(ROUTES.chat, async (c) => c.json(await core.chats.get(c.req.param('id'))));

  r.patch(ROUTES.chat, async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, updateChatBody);
    if (body.projectId !== undefined) {
      const chat = await core.chats.get(id);
      if (chat.projectId !== body.projectId && (await core.changes.get(id)).pending)
        throw new CoreError('conflict', 'Apply or discard the proposed edits first.');
    }
    return c.json(await core.chats.update(id, body));
  });

  r.delete(ROUTES.chat, async (c) => {
    const id = c.req.param('id');
    await core.chats.get(id); // 404 if unknown
    if (core.agent.isRunning(id)) {
      core.agent.abort(id);
      await waitForIdle(core, id);
    }
    await core.chats.remove(id);
    await core.changes.removeForChat(id);
    await core.attachments.removeForChat(id);
    return c.body(null, 204);
  });

  r.post(ROUTES.chatMessages, async (c) => {
    const chatId = c.req.param('id');
    const body = await readJson(c, sendMessageBody);
    const chat = await core.chats.get(chatId);
    const release = claim(chatId);
    try {
      if (body.attachmentIds.length > LIMITS.attachmentsPerMessage)
        throw new CoreError('invalid_request', `At most ${LIMITS.attachmentsPerMessage} attachments per message.`);
      let hasImage = false;
      for (const attId of new Set(body.attachmentIds)) {
        const att = await core.attachments.get(attId); // not_found → 404
        if (att.chatId !== null && att.chatId !== chat.id)
          throw new CoreError('conflict', 'An attachment already belongs to another chat.');
        if (att.kind === 'image') hasImage = true;
      }
      if (hasImage && !(await core.models.get(body.model)).supportsImages) throw new CoreError('model_no_image_input');
    } catch (err) {
      release();
      throw err;
    }
    return streamTurn(c, core, {
      chatId,
      model: body.model,
      newUserMessage: { text: body.text, attachmentIds: body.attachmentIds },
      release,
    });
  });

  r.post(ROUTES.chatRetry, async (c) => {
    const chatId = c.req.param('id');
    const body = await readJson(c, retryBody);
    const chat = await core.chats.get(chatId);
    if (!chat.messages.some((m) => m.role === 'user'))
      throw new CoreError('invalid_request', 'There is no message to retry in this chat.');
    const release = claim(chatId);
    return streamTurn(c, core, { chatId, model: body.model, release });
  });

  /** Apply and discard need the chat idle; the claim also keeps a new turn from starting while they run. */
  const withIdleChat = async <T>(chatId: Id, fn: () => Promise<T>): Promise<T> => {
    if (starting.has(chatId) || core.agent.isRunning(chatId))
      throw new CoreError('conflict', 'Wait for the response to finish before applying or discarding edits.');
    starting.add(chatId);
    try {
      return await fn();
    } finally {
      starting.delete(chatId);
    }
  };

  r.get(ROUTES.chatChanges, async (c) => {
    const id = c.req.param('id');
    await core.chats.get(id);
    return c.json(await core.changes.get(id));
  });

  r.delete(ROUTES.chatChanges, async (c) => {
    const id = c.req.param('id');
    await core.chats.get(id);
    return c.json(await withIdleChat(id, () => core.changes.discard(id)));
  });

  r.post(ROUTES.chatChangesApply, async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, applyChangesBody);
    const chat = await core.chats.get(id);
    if (!chat.projectId) throw new CoreError('conflict', 'This chat has no project to write to.');
    const project = await core.projects.get(chat.projectId);
    return c.json(
      await withIdleChat(id, () =>
        core.changes.apply({
          chatId: id,
          projectRoot: project.rootPath,
          revision: body.revision,
          decisions: body.decisions,
        }),
      ),
    );
  });

  return r;
}
