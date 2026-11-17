// /chats* (CRUD + the two streaming routes)

import {
  applyChangesBody,
  createChatBody,
  ROUTES,
  retryBody,
  sendMessageBody,
  terminalReadAnswerBody,
  undoBatchBody,
  updateChatBody,
} from '@shared/api';
import { LIMITS } from '@shared/constants';
import { TERMINAL } from '@shared/terminal';
import type { Id } from '@shared/types';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CoreError } from '../../core/errors';
import type { Core } from '../../core/types';
import { errorResponse, readJson } from '../http';
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

  /**
   * Apply, discard and archive changes need the chat idle; the claim also keeps a new turn from starting while
   * they run. Rejects rather than aborting or waiting for the run.
   */
  const withIdleChat = async <T>(
    chatId: Id,
    fn: () => Promise<T>,
    conflictMessage = 'Wait for the response to finish before applying or discarding edits.',
  ): Promise<T> => {
    if (starting.has(chatId) || core.agent.isRunning(chatId)) throw new CoreError('conflict', conflictMessage);
    starting.add(chatId);
    try {
      return await fn();
    } finally {
      starting.delete(chatId);
    }
  };

  r.get(ROUTES.chats, async (c) => c.json(await core.chats.list()));

  // `editMode` omitted = 'review'.
  r.post(ROUTES.chats, async (c) => {
    const body = await readJson(c, createChatBody);
    return c.json(await core.chats.create(body));
  });

  r.get(ROUTES.chat, async (c) => c.json(await core.chats.get(c.req.param('id'))));

  /**
   * Rename, move, archive, or change the edit mode. `editMode` takes no run claim and is accepted while a run is
   * active: the agent reads the mode once at turn start, so a change applies from the next turn.
   */
  r.patch(ROUTES.chat, async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, updateChatBody);
    if (body.projectId !== undefined || body.archived !== undefined) {
      const chat = await core.chats.get(id); // 404 before any claim
      const rejectPendingMove = async (projectId: Id | null) => {
        if (body.projectId !== undefined && projectId !== body.projectId && (await core.changes.get(id)).pending)
          throw new CoreError('conflict', 'Apply or discard the proposed edits first.');
      };
      // Only `archived` changes the flag (a move keeps it). Archive changes need the chat idle: hold the run
      // claim across a fresh read so a turn can't start between the check and the write.
      if (body.archived !== undefined) {
        if (starting.has(id))
          throw new CoreError('conflict', 'Wait for the response to finish before archiving or unarchiving this chat.');
        starting.add(id);
        try {
          const fresh = await core.chats.get(id);
          await rejectPendingMove(fresh.projectId);
          if (core.agent.isRunning(id))
            throw new CoreError(
              'conflict',
              'Wait for the response to finish before archiving or unarchiving this chat.',
            );
          return c.json(await core.chats.update(id, body));
        } finally {
          starting.delete(id);
        }
      }
      await rejectPendingMove(chat.projectId);
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
      effort: body.effort,
      terminal: body.terminal,
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
    return streamTurn(c, core, { chatId, model: body.model, effort: body.effort, terminal: body.terminal, release });
  });

  // The client's answer to a `terminal_read_request` (terminal plan §4.2, T2.5). The body is validated before the
  // broker sees it; the broker accepts it once, only for a request still waiting under this chat. Anything else
  // (unknown, expired, answered, another chat's id) is the same 404, so the route reveals nothing about other chats.
  //
  // The body is bounded before it is buffered or parsed (on `Content-Length`, or while streaming when there is none),
  // and a property the schema does not know is refused rather than dropped after it was allocated.
  r.post(
    ROUTES.chatTerminalRead,
    bodyLimit({
      maxSize: TERMINAL.readWireMaxBytes,
      onError: (c) =>
        errorResponse(
          c,
          'invalid_request',
          `The terminal answer is too large. The limit is ${TERMINAL.readWireMaxBytes / (1024 * 1024)} MB.`,
          413,
        ),
    }),
    async (c) => {
      const body = await readJson(c, terminalReadAnswerBody, { strict: true });
      if (!core.terminalReads.answer(c.req.param('id'), c.req.param('requestId'), body))
        throw new CoreError('not_found', 'No terminal read is waiting under that id.');
      return c.body(null, 204);
    },
  );

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

  // The Undo button of an auto batch. Needs the chat idle, like apply: a running turn may still be writing into
  // this batch, and the claim keeps a new turn (or its retry undo) from starting while the files are restored.
  r.post(ROUTES.chatBatchUndo, async (c) => {
    const id = c.req.param('id');
    const batchId = c.req.param('batchId');
    await readJson(c, undoBatchBody);
    await core.chats.get(id); // 404 before any claim
    return c.json(
      await withIdleChat(
        id,
        async () => {
          // Read under the claim, so the project the undo is pinned to is the chat's project right now.
          const chat = await core.chats.get(id);
          if (!chat.projectId) throw new CoreError('conflict', 'This chat has no project to write to.');
          const project = await core.projects.get(chat.projectId).catch((err) => {
            // A project that no longer exists leaves the chat with nowhere to write.
            if (err instanceof CoreError && err.code === 'not_found') {
              throw new CoreError('conflict', 'This chat has no project to write to.');
            }
            throw err;
          });
          return core.changes.undoBatch({
            chatId: id,
            projectId: project.id,
            projectRoot: project.rootPath,
            batchId,
          });
        },
        'Wait for the response to finish before undoing edits.',
      ),
    );
  });

  return r;
}
