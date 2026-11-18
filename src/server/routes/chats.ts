// /chats* (CRUD + the two streaming routes)

import {
  applyChangesBody,
  createChatBody,
  EDIT_MODE_CHANGED,
  ROUTES,
  retryBody,
  sendMessageBody,
  terminalReadAnswerBody,
  undoBatchBody,
  updateChatBody,
} from '@shared/api';
import { LIMITS } from '@shared/constants';
import { TERMINAL } from '@shared/terminal';
import type { EditMode, Id } from '@shared/types';
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

  /**
   * `expected` is the edit mode the client showed when the user acted; omitted means `'review'`, so a request that
   * showed nothing can only start a Review turn. A mismatch is refused before anything changes, so the user can look
   * at Review / Auto and act again.
   */
  const checkEditMode = (stored: EditMode, expected: EditMode | undefined): EditMode => {
    if (stored !== (expected ?? 'review')) throw new CoreError('conflict', EDIT_MODE_CHANGED);
    return stored;
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
   *
   * MODE GUARD (invariant): `expectedEditMode` and `expectedProjectId` are compared by `chats.update`, under the
   * storage lock that commits the change, so a mode PATCH or a move landing between a check here and the write can't
   * slip through. A move decides whether to warn about a folder without Git from the mode the client showed, so it
   * must not go through on a mode the chat no longer has; a move that names no mode expects `'review'`. Turning Auto
   * on names the project whose warning was decided, so a move that lands first refuses it.
   */
  r.patch(ROUTES.chat, async (c) => {
    const id = c.req.param('id');
    const { expectedEditMode, expectedProjectId, ...patch } = await readJson(c, updateChatBody);
    const expect: { editMode?: EditMode; projectId?: Id | null } = {};
    const mode = expectedEditMode ?? (patch.projectId !== undefined ? 'review' : undefined);
    if (mode !== undefined) expect.editMode = mode;
    if (expectedProjectId !== undefined) expect.projectId = expectedProjectId;
    if (patch.projectId !== undefined || patch.archived !== undefined) {
      const chat = await core.chats.get(id); // 404 before any claim
      const rejectPendingMove = async (projectId: Id | null) => {
        if (patch.projectId !== undefined && projectId !== patch.projectId && (await core.changes.get(id)).pending)
          throw new CoreError('conflict', 'Apply or discard the proposed edits first.');
      };
      // Only `archived` changes the flag (a move keeps it). Archive changes need the chat idle: hold the run
      // claim across a fresh read so a turn can't start between the check and the write.
      if (patch.archived !== undefined) {
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
          return c.json(await core.chats.update(id, patch, expect));
        } finally {
          starting.delete(id);
        }
      }
      await rejectPendingMove(chat.projectId);
    }
    return c.json(await core.chats.update(id, patch, expect));
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

  // CHECKED MODE IS THE TURN'S MODE (invariant), for both routes that start a turn: the chat is read once, under the
  // start claim; the mode the client showed (`expectedEditMode`, omitted = 'review') is checked against that read,
  // and the turn is handed that same mode, and the project from the same read, to run in. A PATCH takes no claim and
  // can land at any time, so a check here followed by a second read in the agent could start a turn in a mode the
  // user wasn't shown, or run the checked mode in the project a move just put the chat in. A mismatch is refused
  // (409) before anything is stored or started.
  r.post(ROUTES.chatMessages, async (c) => {
    const chatId = c.req.param('id');
    const body = await readJson(c, sendMessageBody);
    const release = claim(chatId);
    let editMode: EditMode;
    let projectId: Id | null;
    try {
      const chat = await core.chats.get(chatId);
      editMode = checkEditMode(chat.editMode, body.expectedEditMode);
      projectId = chat.projectId;
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
      editMode,
      projectId,
      release,
    });
  });

  r.post(ROUTES.chatRetry, async (c) => {
    const chatId = c.req.param('id');
    const body = await readJson(c, retryBody);
    const release = claim(chatId);
    let editMode: EditMode;
    let projectId: Id | null;
    try {
      const chat = await core.chats.get(chatId);
      if (!chat.messages.some((m) => m.role === 'user'))
        throw new CoreError('invalid_request', 'There is no message to retry in this chat.');
      editMode = checkEditMode(chat.editMode, body.expectedEditMode);
      projectId = chat.projectId;
    } catch (err) {
      release();
      throw err;
    }
    return streamTurn(c, core, {
      chatId,
      model: body.model,
      effort: body.effort,
      terminal: body.terminal,
      editMode,
      projectId,
      release,
    });
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
