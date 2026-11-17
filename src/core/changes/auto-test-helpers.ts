// Test helpers shared by `auto.test.ts` and `undo.test.ts` (not imported by production code): a real temp project
// folder, a real data dir, a change service with a swappable `beforeWrite` hook, and small tool-like helpers that
// compute `baseHash` from the disk the way the edit tools do.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EditMode, Id } from '@shared/types';
import { ensureDataDir } from '../storage/paths';
import { makeTempDir } from '../storage/test-helpers';
import type { SandboxOptions } from '../tools/sandbox';
import type { EditToolName, ToolChanges } from '../tools/types';
import { sha256 } from './blobs';
import { createChangesService } from './index';

export type WriteHookInfo = { op: 'auto' | 'apply' | 'undo'; chatId: Id; path: string };

export interface AutoSetupOptions {
  /** Put the data dir inside the project (and deny it to the sandbox), as the app can be configured to. */
  dataDirInsideProject?: boolean;
  chatProjectId?: (chatId: Id) => Promise<Id | null>;
}

/** A gate: `entered` resolves once someone called `hold()`, and `hold()` waits until `open()`. */
export function gate() {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  const enteredP = new Promise<void>((r) => {
    entered = r;
  });
  return {
    entered: enteredP,
    open,
    async hold() {
      entered();
      await opened;
    },
  };
}

/** Lets already-queued work run: a few macrotask turns. Only ever used to show that something is still blocked. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Polls `cond` until it holds. No timing assertion: a condition that never holds ends in the test's timeout. */
export async function waitFor(cond: () => Promise<boolean> | boolean): Promise<void> {
  while (!(await cond())) await new Promise<void>((r) => setImmediate(r));
}

export async function setupAuto(opts: AutoSetupOptions = {}) {
  const base = await makeTempDir();
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  const realRoot = await fs.realpath(root);
  const dataRoot = opts.dataDirInsideProject ? path.join(realRoot, 'appdata') : path.join(base, 'data');
  const dataDir = (await ensureDataDir(dataRoot)).root;
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  const realOutside = await fs.realpath(outside);

  const hooks: { beforeWrite?: (info: WriteHookInfo) => Promise<void> | void } = {};
  const sandbox: SandboxOptions | undefined = opts.dataDirInsideProject
    ? { deniedRoots: [await fs.realpath(dataDir)] }
    : undefined;
  const svc = createChangesService({
    dataDir,
    sandbox,
    chatProjectId: opts.chatProjectId,
    beforeWrite: (info) => hooks.beforeWrite?.(info),
  });

  const abs = (rel: string) => path.join(realRoot, rel);
  const seed = async (rel: string, data: string | Buffer, mode?: number) => {
    await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
    await fs.writeFile(abs(rel), data);
    if (mode !== undefined) await fs.chmod(abs(rel), mode);
  };
  const read = (rel: string) => fs.readFile(abs(rel), 'utf8');
  const readBuf = (rel: string) => fs.readFile(abs(rel));
  const exists = (rel: string) =>
    fs.lstat(abs(rel)).then(
      () => true,
      () => false,
    );
  const modeOf = async (rel: string) => (await fs.stat(abs(rel))).mode & 0o777;
  /** The sha256 of the file as the tool would see it right now ('' when missing). */
  const hashNow = async (rel: string) => {
    try {
      return sha256(await fs.readFile(abs(rel)));
    } catch {
      return '';
    }
  };

  /** An auto-mode `ToolChanges` for one step of a turn. */
  const turn = (o: { chatId?: Id; turnId?: Id; messageId?: Id; projectId?: Id; mode?: EditMode } = {}): ToolChanges =>
    svc.tools({
      chatId: o.chatId ?? 'chat1',
      projectId: o.projectId ?? 'p',
      projectRoot: realRoot,
      messageId: o.messageId ?? 'm1',
      turnId: o.turnId ?? 't1',
      mode: o.mode ?? 'auto',
    });

  /** What `read_file` does: returns the disk text and records what this chat saw. */
  const readFile = async (tc: ToolChanges, rel: string) => {
    const bytes = await fs.readFile(abs(rel));
    tc.noteRead(rel, bytes);
    return bytes.toString('utf8');
  };
  /** A tool call that built its change from the file as it is on disk right now. */
  const put = async (tc: ToolChanges, rel: string, content: string | null, tool: EditToolName = 'write_file') =>
    tc.write(rel, content, { tool, baseHash: await hashNow(rel) });
  /** Read then write, as a well-behaved model does. */
  const readPut = async (tc: ToolChanges, rel: string, content: string | null, tool: EditToolName = 'write_file') => {
    if (await exists(rel)) await readFile(tc, rel);
    return put(tc, rel, content, tool);
  };

  const blobDir = (chatId = 'chat1') => path.join(dataDir, 'changes', `${chatId}.blobs`);
  const blobs = async (chatId = 'chat1') => (await fs.readdir(blobDir(chatId)).catch(() => [])).sort();
  const storeFile = (chatId = 'chat1') => path.join(dataDir, 'changes', `${chatId}.json`);
  const readStore = async (chatId = 'chat1') => JSON.parse(await fs.readFile(storeFile(chatId), 'utf8'));
  const writeStore = async (store: unknown, chatId = 'chat1') => {
    await fs.mkdir(path.dirname(storeFile(chatId)), { recursive: true });
    await fs.writeFile(storeFile(chatId), JSON.stringify(store));
  };
  const get = (chatId = 'chat1') => svc.get(chatId);
  const undo = (batchId: Id, o: { chatId?: Id; projectId?: Id } = {}) =>
    svc.undoBatch({ chatId: o.chatId ?? 'chat1', projectId: o.projectId ?? 'p', projectRoot: realRoot, batchId });
  const retry = (turnId: Id, o: { chatId?: Id; projectId?: Id; mode?: EditMode } = {}) =>
    svc.prepareRetry({
      chatId: o.chatId ?? 'chat1',
      projectId: o.projectId ?? 'p',
      projectRoot: realRoot,
      turnId,
      mode: o.mode ?? 'auto',
    });

  return {
    svc,
    hooks,
    root: realRoot,
    dataDir,
    outside: realOutside,
    abs,
    seed,
    read,
    readBuf,
    exists,
    modeOf,
    hashNow,
    turn,
    readFile,
    put,
    readPut,
    blobDir,
    blobs,
    storeFile,
    readStore,
    writeStore,
    get,
    undo,
    retry,
  };
}

export type AutoSetup = Awaited<ReturnType<typeof setupAuto>>;
