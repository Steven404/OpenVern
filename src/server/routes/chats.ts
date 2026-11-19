// /chats* (CRUD + the two streaming routes)

import {
  applyChangesBody,
  CHAT_HAS_NO_PROJECT,
  CHAT_PROJECT_CHANGED,
  createChatBody,
  EDIT_MODE_CHANGED,
  MOVE_WHILE_RUNNING,
  PROJECT_NOT_IN_GIT,
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
import { inGitRepo } from '../../core/storage/projects';
import type { ChatUpdateExpect, Core } from '../../core/types';
import { errorResponse, readJson } from '../http';
import { streamTurn } from '../sse';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits (bounded) for an aborted run to finish persisting, so we don't delete a chat under its feet. */
async function waitForIdle(core: Core, chatId: Id, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (core.agent.isRunning(chatId) && Date.now() < deadline) await sleep(10);
}

/**
 * The run claims of one core, shared by the chat and project routes. Every check and claim here is synchronous, so a
 * check and the claim it guards can't be split by another request.
 *
 * NO PROJECT CHANGE DURING A TURN (invariant): a chat's project never changes while a turn runs or is starting in it,
 * so a turn's writes stay in one project and one batch. A move holds `moving` from its check through its commit, and
 * a project removal holds `removing` from its check through `projects.remove`; a turn start is refused while either
 * covers its chat (`claimTurn`, then `checkNotRemoving` on the chat read under that claim). Each side checks the
 * other's claim before taking its own, so of a turn start and a move or removal racing, exactly one goes ahead.
 */
export interface RunClaims {
  /** Chats whose turn is being set up (validated, stream not yet started), or that hold the idle claim. */
  readonly starting: Set<Id>;
  /** True while a turn of the chat is starting or running (the idle claim of Apply, Undo or archive isn't a turn). */
  turnActive(chatId: Id): boolean;
  /** Takes a turn's start claim, or throws `conflict`. Returns a once-only release function. */
  claimTurn(chatId: Id): () => void;
  /** Refuses a turn whose chat (read under the start claim) is in a project being removed: it is about to move. */
  checkNotRemoving(projectId: Id | null): void;
  /** Holds off turn starts in the chat while its move commits. Throws `MOVE_WHILE_RUNNING` while a turn is active. */
  holdMove(chatId: Id): () => void;
  /** Holds off turn starts in the project's chats while it is removed (the caller checks its chats right after). */
  holdRemoval(projectId: Id): () => void;
}

const claimsByCore = new WeakMap<Core, RunClaims>();

/** Counts holders per key, so overlapping holds on one chat or project each release only their own. */
function holdIn(map: Map<Id, number>, key: Id): () => void {
  map.set(key, (map.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (map.get(key) ?? 1) - 1;
    if (n > 0) map.set(key, n);
    else map.delete(key);
  };
}

export function runClaims(core: Core): RunClaims {
  const existing = claimsByCore.get(core);
  if (existing) return existing;
  const starting = new Set<Id>();
  /** The chats in `starting` whose claim is a turn start. */
  const turns = new Set<Id>();
  const moving = new Map<Id, number>();
  const removing = new Map<Id, number>();
  // `core.agent` is read at each call (tests swap it), never captured.
  const claims: RunClaims = {
    starting,
    turnActive: (chatId) => turns.has(chatId) || core.agent.isRunning(chatId),
    claimTurn(chatId) {
      if (starting.has(chatId) || core.agent.isRunning(chatId))
        throw new CoreError('conflict', 'A response is already being generated for this chat.');
      // The chat is changing project right now: once the move commits, the client must look at it again.
      if (moving.has(chatId)) throw new CoreError('conflict', CHAT_PROJECT_CHANGED);
      starting.add(chatId);
      turns.add(chatId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        starting.delete(chatId);
        turns.delete(chatId);
      };
    },
    checkNotRemoving(projectId) {
      if (projectId !== null && removing.has(projectId)) throw new CoreError('conflict', CHAT_PROJECT_CHANGED);
    },
    holdMove(chatId) {
      if (claims.turnActive(chatId)) throw new CoreError('conflict', MOVE_WHILE_RUNNING);
      return holdIn(moving, chatId);
    },
    holdRemoval: (projectId) => holdIn(removing, projectId),
  };
  claimsByCore.set(core, claims);
  return claims;
}

export function chatRoutes(core: Core): Hono {
  const r = new Hono();
  const claims = runClaims(core);
  const { starting } = claims;

  /** Synchronous check-and-claim of a turn start. Returns a once-only release function. */
  const claim = (chatId: Id): (() => void) => claims.claimTurn(chatId);

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

  /**
   * `expected` is the project the client showed (`null` = no project); omitted means unchecked. A mismatch is refused
   * before anything changes, like a mode mismatch, so a turn never runs in a project the sender didn't see.
   */
  const checkProject = (stored: Id | null, expected: Id | null | undefined): Id | null => {
    if (expected !== undefined && stored !== expected) throw new CoreError('conflict', CHAT_PROJECT_CHANGED);
    return stored;
  };

  /**
   * NO-GIT WARNING (invariant): Auto never starts in a folder outside Git that its client showed as inside Git, where
   * the no-Git warning was skipped. The folder is checked again at commit time (a folder can lose its repository at
   * any time, and the client's list may be old). `shown` is what the client showed: `false` means the folder was shown
   * outside Git, so its warning was decided; `true` or omitted (a request that showed nothing) needs the folder to be
   * in Git now.
   */
  const checkAutoGit = async (projectId: Id, shown: boolean | undefined): Promise<void> => {
    if (shown === false) return;
    const project = await core.projects.get(projectId);
    if (!(await inGitRepo(project.rootPath))) throw new CoreError('conflict', PROJECT_NOT_IN_GIT);
  };

  r.get(ROUTES.chats, async (c) => c.json(await core.chats.list()));

  // `editMode` omitted = 'review'. Auto in a project is checked against the folder's Git status first (`checkAutoGit`).
  r.post(ROUTES.chats, async (c) => {
    const { expectedInGitRepo, ...body } = await readJson(c, createChatBody);
    if (body.editMode === 'auto' && body.projectId !== null) await checkAutoGit(body.projectId, expectedInGitRepo);
    return c.json(await core.chats.create(body));
  });

  r.get(ROUTES.chat, async (c) => c.json(await core.chats.get(c.req.param('id'))));

  /**
   * Rename, move, archive, or change the edit mode. `editMode` takes no run claim and is accepted while a run is
   * active: the agent reads the mode once at turn start, so a change applies from the next turn. A move (any PATCH
   * with `projectId`) is refused while a turn runs or is starting (`MOVE_WHILE_RUNNING`), and no turn can start until
   * it has committed or failed (`holdMove`; see NO PROJECT CHANGE DURING A TURN).
   *
   * MODE GUARD (invariant): `expectedEditMode` and `expectedProjectId` are compared by `chats.update`, under the
   * storage lock that commits the change, so a mode PATCH or a move landing between a check here and the write can't
   * slip through. A move decides whether to warn about a folder without Git from the mode the client showed, so it
   * must not go through on a mode the chat no longer has; a move that names no mode expects `'review'`. Turning Auto
   * on names the project whose warning was decided, so a move that lands first refuses it. Turning Auto on, or moving
   * an Auto chat into another project, also checks that project's folder against the Git status the client showed
   * (`checkAutoGit`), under that same lock, with the project the chat will be in.
   */
  r.patch(ROUTES.chat, async (c) => {
    const id = c.req.param('id');
    const { expectedEditMode, expectedProjectId, expectedInGitRepo, ...patch } = await readJson(c, updateChatBody);
    const expect: ChatUpdateExpect = {
      checkAutoProject: (projectId) => checkAutoGit(projectId, expectedInGitRepo),
    };
    const mode = expectedEditMode ?? (patch.projectId !== undefined ? 'review' : undefined);
    if (mode !== undefined) expect.editMode = mode;
    if (expectedProjectId !== undefined) expect.projectId = expectedProjectId;
    if (patch.projectId !== undefined || patch.archived !== undefined) {
      await core.chats.get(id); // 404 before any claim
      // A move is refused while a turn of the chat runs or is starting, and from here until it has committed or failed
      // no turn can start (NO PROJECT CHANGE DURING A TURN). Checked and taken synchronously, so a turn start can't
      // slip in between. It is not the idle claim: Apply, Undo and archive may still run, and the move waits for
      // them on the change-store lock as before.
      const releaseMove = patch.projectId !== undefined ? claims.holdMove(id) : () => {};
      try {
        /**
         * Commits the patch; `beforeCommit` runs right before the write, after the pending check. A move is refused
         * while proposals are pending, and commits under the chat's change-store lock (`changeProject`) with that
         * check, read fresh there: a stage can't slip in between the check and the write, and the move can't land
         * between Apply's project check and its writes. Once the project changed, `changeProject` resets the chat's
         * per-project Auto state under that same lock.
         */
        const commit = (beforeCommit?: () => void) => {
          const { projectId } = patch;
          if (projectId === undefined) {
            beforeCommit?.();
            return core.chats.update(id, patch, expect);
          }
          // LOCK ORDER: the chat's change-store lock (`changeProject`), then the chat storage lock (`chats.update`),
          // then the chat file's lock (inside it).
          // A project change never happens while a turn runs (`holdMove` above), so a turn's writes stay in one batch
          // per project; the reset in `changeProject` and the turn's pinned project remain as defence in depth.
          return core.changes.changeProject(id, async ({ pending }) => {
            if (pending && (await core.chats.get(id)).projectId !== projectId)
              throw new CoreError('conflict', 'Apply or discard the proposed edits first.');
            beforeCommit?.();
            return core.chats.update(id, patch, expect);
          });
        };
        // Only `archived` changes the flag (a move keeps it). Archive changes need the chat idle: hold the run
        // claim across the commit so a turn can't start between the check and the write.
        if (patch.archived !== undefined) {
          const busy = () =>
            new CoreError('conflict', 'Wait for the response to finish before archiving or unarchiving this chat.');
          if (starting.has(id)) throw busy();
          starting.add(id);
          try {
            await core.chats.get(id); // fresh read under the claim: 404 if the chat went meanwhile
            return c.json(
              await commit(() => {
                if (core.agent.isRunning(id)) throw busy();
              }),
            );
          } finally {
            starting.delete(id);
          }
        }
        return c.json(await commit());
      } finally {
        releaseMove();
      }
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
  // and the turn is handed that same mode, and the project from the same read, to run in. A mode PATCH takes no claim
  // and can land at any time, so a check here followed by a second read in the agent could start a turn in a mode the
  // user wasn't shown. A mismatch is refused
  // (409) before anything is stored or started. The project the client showed (`expectedProjectId`) is checked
  // against the same read, so a chat moved from another window can't run in a project the sender never saw. A retry
  // whose turn wrote into another project that still exists is refused by the agent itself (a stream error, nothing
  // stored), right before its undo, where the run claim keeps that check valid. A turn doesn't start while its chat
  // is moving or its project is being removed (`CHAT_PROJECT_CHANGED`), and while it is starting or running neither
  // can begin (NO PROJECT CHANGE DURING A TURN), so the project read here stays the chat's project for the whole turn.
  r.post(ROUTES.chatMessages, async (c) => {
    const chatId = c.req.param('id');
    const body = await readJson(c, sendMessageBody);
    const release = claim(chatId);
    let editMode: EditMode;
    let projectId: Id | null;
    try {
      const chat = await core.chats.get(chatId);
      claims.checkNotRemoving(chat.projectId);
      editMode = checkEditMode(chat.editMode, body.expectedEditMode);
      projectId = checkProject(chat.projectId, body.expectedProjectId);
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
      claims.checkNotRemoving(chat.projectId);
      editMode = checkEditMode(chat.editMode, body.expectedEditMode);
      projectId = checkProject(chat.projectId, body.expectedProjectId);
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

  // Review Apply. The chat's project is read under the claim to find the folder, and handed to the change service with
  // the project the client showed (`expectedProjectId`). The service reads the chat's project again under its store
  // lock, where a move or a detach can't commit (`changeProject`), and compares all of them, and the project the
  // proposals were made for, before any write and holding that lock through the writes. So proposals are never written
  // into a project they weren't made for, that the chat has left, or that the user wasn't shown (409, nothing written).
  r.post(ROUTES.chatChangesApply, async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, applyChangesBody);
    await core.chats.get(id); // 404 before any claim
    return c.json(
      await withIdleChat(id, async () => {
        const chat = await core.chats.get(id);
        if (!chat.projectId) throw new CoreError('conflict', CHAT_HAS_NO_PROJECT);
        const project = await core.projects.get(chat.projectId);
        return core.changes.apply({
          chatId: id,
          projectId: project.id,
          projectRoot: project.rootPath,
          ...(body.expectedProjectId !== undefined ? { expectedProjectId: body.expectedProjectId } : {}),
          revision: body.revision,
          decisions: body.decisions,
        });
      }),
    );
  });

  // The Undo button of an auto batch. Needs the chat idle, like apply: a running turn may still be writing into
  // this batch, and the claim keeps a new turn (or its retry undo) from starting while the files are restored. The
  // project read here finds the folder; the change service reads the chat's project again under its store lock, where
  // a move or a detach can't commit (`changeProject`), and refuses (409, nothing restored) when the chat moved.
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
          if (!chat.projectId) throw new CoreError('conflict', CHAT_HAS_NO_PROJECT);
          const project = await core.projects.get(chat.projectId).catch((err) => {
            // A project that no longer exists leaves the chat with nowhere to write.
            if (err instanceof CoreError && err.code === 'not_found') {
              throw new CoreError('conflict', CHAT_HAS_NO_PROJECT);
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
