// This module is reached only through the dock or a dynamic read import. Never export it from the eager barrel.
import {
  TERMINAL,
  type TerminalBridge,
  type TerminalDataEvent,
  type TerminalDefaultFolder,
  type TerminalInfo,
  type TerminalReadAnswer,
  type TerminalReadRequest,
  type TerminalStatus,
} from '@shared/terminal';
import type { Id } from '@shared/types';
import { readTerminalBuffer } from './read';
import { type LoadedTerminalEntry, setLoadedTerminalRegistry, terminalAttachesHeld } from './registry-handle';
import { splitTerminalWrite } from './write';
import { createFitAddon, createTerminal, TERMINAL_DOCK_PADDING, waitForTerminalFont } from './xterm';

export const TERMINAL_RESYNC_PAUSE_MS = 250;
export const TERMINAL_SKIPPED_OUTPUT = '[Terminal output was skipped while catching up.]';
export const TERMINAL_PASTE_TOO_LARGE =
  'Paste too large: the terminal accepts at most 1 MiB at a time. Nothing was sent.';

class NoTerminalError extends Error {}

/** An attach that waited out a hand-over of its id and was then no longer wanted (`TerminalOpenOptions.wanted`). */
export class TerminalAttachCancelled extends Error {
  constructor() {
    super('Terminal attach cancelled');
  }
}

export class TerminalRegistry {
  private entries = new Map<Id, TerminalEntry>();
  private revisions = new Map<Id, number>();
  get(id: Id): TerminalEntry | undefined {
    const entry = this.entries.get(id);
    if (entry?.disposed) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }
  /** Every `attach` in flight per id, from its first step (a wait for a free slot included) until it settles. */
  private attaching = new Map<Id, Set<Promise<TerminalEntry>>>();
  attach(id: Id, bridge: TerminalBridge, options: TerminalOpenOptions): Promise<TerminalEntry> {
    // A hand-over of this id is under way (`holdTerminalAttaches`): wait it out before asking main for anything, then
    // go on only if the caller still wants the id. Not tracked meanwhile, so the hand-over's `settle` never waits for
    // an attach that is waiting for the hand-over.
    const held = terminalAttachesHeld(id);
    if (held) {
      return held.then(() => {
        if (options.wanted?.() === false) throw new TerminalAttachCancelled();
        return this.attach(id, bridge, options);
      });
    }
    const attaching = this.attachNow(id, bridge, options);
    let pending = this.attaching.get(id);
    if (!pending) {
      pending = new Set();
      this.attaching.set(id, pending);
    }
    const tracked = pending;
    tracked.add(attaching);
    const settled = () => {
      tracked.delete(attaching);
      if (tracked.size === 0 && this.attaching.get(id) === tracked) this.attaching.delete(id);
    };
    attaching.then(settled, settled);
    return attaching;
  }
  /**
   * Resolves once every `attach` of `id` already under way has settled, its wait for a free slot (before the entry
   * exists) included, then gives the entry with its `open` settled, if one is left. The draft hand-over waits on this
   * so main moves the shell an attach is about to start, not the one before or none.
   */
  async settle(id: Id): Promise<TerminalEntry | undefined> {
    for (let pending = this.attaching.get(id); pending?.size; pending = this.attaching.get(id)) {
      await Promise.allSettled(pending);
    }
    await this.get(id)?.ready.catch(() => {});
    return this.get(id);
  }
  private async attachNow(id: Id, bridge: TerminalBridge, options: TerminalOpenOptions): Promise<TerminalEntry> {
    if (options.restart && this.get(id)?.info?.status.state === 'exited') this.dispose(id);
    let entry = this.get(id);
    if (!entry) {
      if (this.entries.size >= TERMINAL.maxSessions) {
        const held = new Set((await bridge.list()).map((item) => item.chatId));
        for (const [key, candidate] of this.entries) {
          if (candidate.info && !held.has(key)) this.dispose(key);
        }
        if (this.entries.size >= TERMINAL.maxSessions) {
          const oldestExited = [...this.entries].find(([, candidate]) => candidate.info?.status.state === 'exited');
          if (oldestExited) this.dispose(oldestExited[0]);
        }
        // Another attach may have completed while list was pending. Straight on, not through `attach`: this attach is
        // already tracked, and a hand-over that began meanwhile is waiting for it in `settle`.
        if (this.get(id)) return this.attachNow(id, bridge, options);
        if (this.entries.size >= TERMINAL.maxSessions)
          throw new Error(
            `At most ${TERMINAL.maxSessions} terminals can run at once, counting any that are still closing. End one to open another.`,
          );
      }
      entry = new TerminalEntry(id, bridge);
      this.entries.set(id, entry);
      const created = entry;
      created.ready = created.open(options).catch((error: unknown) => {
        // The entry's current id: a rename may have moved it while `open` was in flight.
        if (this.get(created.id) === created) {
          created.dispose();
          this.entries.delete(created.id);
        }
        throw error;
      });
    }
    await entry.ready;
    return entry;
  }
  /**
   * Files the emulator held under `from` under `to` (the New Chat screen's terminal joining the chat created from it,
   * after main moved the session with `adopt`). Same emulator, scrollback and subscriptions; from here on it answers
   * to `to` and writes and resizes go to `to`. Reads in flight for `from` answer `no_terminal`. False when `from` has
   * no emulator.
   *
   * Relies on Electron delivering a window's main → renderer messages in the order main sent them: the `adopt` reply
   * goes out before any data event carrying `to` (main renames synchronously and the reply is queued before the
   * PTY's next output callback can run), and the caller renames as soon as the reply resolves, in the same task. So no
   * event for `to` reaches the entry while it still answers to `from`, and none for `from` arrives after.
   *
   * With `only`, renames nothing unless that is the entry filed under `from` (the hand-over moves the emulator it had
   * before it asked main, never one made since).
   */
  rename(from: Id, to: Id, only?: LoadedTerminalEntry): boolean {
    if (from === to) return false;
    const entry = this.get(from);
    if (!entry || (only !== undefined && entry !== only)) return false;
    // A fresh chat has no emulator; one left behind under its id would answer for a session main no longer has there.
    if (this.entries.has(to)) this.dispose(to);
    this.revisions.set(from, (this.revisions.get(from) ?? 0) + 1);
    this.entries.delete(from);
    entry.rekey(to);
    this.entries.set(to, entry);
    return true;
  }
  dispose(id: Id): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    this.entries.get(id)?.dispose();
    this.entries.delete(id);
  }
  disposeAll(): void {
    for (const id of this.entries.keys()) this.dispose(id);
  }
  async read(id: Id, bridge: TerminalBridge, request: TerminalReadRequest): Promise<TerminalReadAnswer> {
    for (const value of [request.startLine, request.count]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) return { ok: false, reason: 'unavailable' };
    }
    let entry = this.get(id);
    const revision = this.revisions.get(id);
    try {
      if (!entry) {
        const info = (await bridge.list()).find((item) => item.chatId === id);
        if (revision !== this.revisions.get(id)) return { ok: false, reason: 'no_terminal' };
        if (!info) {
          if (entry) this.dispose(id);
          return { ok: false, reason: 'no_terminal' };
        }
        entry ??= await this.attach(id, bridge, { cwd: info.cwd, info });
      }
      await entry.ready;
      await entry.flush();
      if (entry.info.status.state === 'exited') {
        const exists = (await bridge.list()).some((item) => item.chatId === id);
        if (!exists) {
          if (this.get(id) === entry) this.dispose(id);
          return { ok: false, reason: 'no_terminal' };
        }
      }
      if (entry.disposed) return { ok: false, reason: 'no_terminal' };
      return { ok: true, result: readTerminalBuffer(entry.term.buffer.active, entry.info, request) };
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof NoTerminalError || entry?.disposed || revision !== this.revisions.get(id)
            ? 'no_terminal'
            : 'unavailable',
      };
    }
  }
}

export interface TerminalOpenOptions {
  cwd: string | null;
  /** Where main starts the shell when `cwd` is null (main resolves the folder). Absent = home. */
  defaultFolder?: TerminalDefaultFolder;
  restart?: boolean;
  info?: TerminalInfo;
  host?: HTMLElement;
  /** Called once when this attach started a new shell (not when it attached to an existing session). */
  onCreated?: () => void;
  /**
   * Asked once an attach has waited out a hand-over of its id (`holdTerminalAttaches`), before it asks main for the
   * session: false drops the attach with `TerminalAttachCancelled`. Absent = still wanted.
   */
  wanted?: () => boolean;
}

export class TerminalEntry {
  readonly term = createTerminal();
  readonly fit = createFitAddon();
  info!: TerminalInfo;
  ready: Promise<void> = Promise.resolve();
  disposed = false;
  private replaying = true;
  private resyncing = false;
  private resyncTimer: ReturnType<typeof setTimeout> | undefined;
  private bufferingReplay = false;
  private recoveryOverflow = false;
  private pendingChars = 0;
  private inputNotice: string | null = null;
  get notice(): string | null {
    return this.resyncing ? 'Terminal output was skipped. Restoring recent output…' : this.inputNotice;
  }
  private cancelParsing = new Set<(error: Error) => void>();
  private seq: number | null = null;
  private pending: TerminalDataEvent[] = [];
  private exit: TerminalStatus | null = null;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  /** Changes only through `rekey` (the registry's `rename`). Every filter and call below reads it at the time. */
  private key: Id;
  get id(): Id {
    return this.key;
  }
  constructor(
    id: Id,
    private bridge: TerminalBridge,
  ) {
    this.key = id;
    this.term.loadAddon(this.fit);
    this.offs.push(
      bridge.onData((event) => {
        if (event.chatId !== this.id || this.disposed) return;
        if (this.resyncing) {
          if (!this.bufferingReplay || this.recoveryOverflow) return;
          if (this.pendingChars + event.data.length > TERMINAL.replayMaxBytes) {
            this.recoveryOverflow = true;
            this.pending = [];
            this.pendingChars = 0;
            return;
          }
          this.pendingChars += event.data.length;
        }
        this.pending.push(event);
        if (this.seq !== null && !this.resyncing) this.drain();
      }),
      bridge.onExit((event) => {
        if (event.chatId !== this.id) return;
        this.exit = event.status;
        if (this.info) this.info = { ...this.info, status: event.status };
        this.notify();
      }),
    );
    const input = this.term.onData((data) => {
      if (this.replaying || this.disposed || this.info?.status.state !== 'running') return;
      if (new TextEncoder().encode(data).byteLength > TERMINAL.pendingInputMaxBytes) {
        this.inputNotice = TERMINAL_PASTE_TOO_LARGE;
        this.notify();
        return;
      }
      this.inputNotice = null;
      this.notify();
      for (const piece of splitTerminalWrite(data)) bridge.write(this.id, piece);
    });
    const resize = this.term.onResize(({ cols, rows }) => {
      if (this.replaying || !this.info) return;
      this.info = { ...this.info, cols, rows };
      if (this.info.status.state === 'running') bridge.resize(this.id, cols, rows);
    });
    const selection = this.term.onSelectionChange(() => this.notify());
    this.offs.push(
      () => input.dispose(),
      () => resize.dispose(),
      () => selection.dispose(),
    );
  }
  /** Answers to another chat id from now on (see `TerminalRegistry.rename`). */
  rekey(to: Id): void {
    this.key = to;
    if (this.info) this.info = { ...this.info, chatId: to };
    this.notify();
  }
  async open(options: TerminalOpenOptions): Promise<void> {
    const detach = options.host ? this.mount(options.host) : undefined;
    const size = { cols: this.term.cols, rows: this.term.rows };
    detach?.();
    // The id this open asks for. Any cleanup below is bound to it, never to `this.id` read after the await.
    const id = this.id;
    const result = await this.bridge.open({
      chatId: id,
      cwd: options.cwd,
      ...(options.cwd === null && options.defaultFolder === 'documents' ? { defaultFolder: 'documents' } : {}),
      cols: options.info?.cols ?? size.cols,
      rows: options.info?.rows ?? size.rows,
      ...(options.restart ? { restart: true } : {}),
    });
    if (options.info && result.created) {
      this.dispose();
      await this.bridge.close(id);
      throw new NoTerminalError();
    }
    if (result.created && !this.disposed) options.onCreated?.();
    if (this.disposed) throw new Error('Terminal ended');
    this.info = { ...result.info, status: this.exit ?? result.info.status };
    // Never fit until replay has parsed: an unseen terminal must wrap exactly as main's shell did.
    this.term.resize(result.info.cols, result.info.rows);
    // A truncated replay starts at a line break: preserve it verbatim, without synthetic history.
    if (result.replay) await this.parse(result.replay);
    if (this.disposed) throw new Error('Terminal ended');
    this.seq = result.seq;
    this.replaying = false;
    this.drain();
  }
  private drain(): void {
    for (const event of this.pending.splice(0).sort((a, b) => a.seq - b.seq)) {
      if (event.seq <= (this.seq ?? -1)) continue;
      if (this.resyncing) continue;
      try {
        this.term.write(event.data);
        this.seq = event.seq;
      } catch {
        this.startResync();
      }
    }
  }
  async flush(): Promise<void> {
    if (this.disposed) throw new NoTerminalError();
    if (this.resyncing) throw new Error('Terminal is resynchronising');
    try {
      await this.parse('');
    } catch (error) {
      if (!this.disposed) this.startResync();
      throw error;
    }
    if (this.resyncing) throw new Error('Terminal is resynchronising');
  }
  /**
   * Keeps recovery from asking main for the session until `resume` is called. The draft hand-over holds it while main
   * renames the session: a recovery `open` sent under the draft id after main moved the shell would start a fresh one
   * there. `settled` resolves once a recovery already under way (its `open` maybe sent) has finished. A recovery due
   * meanwhile waits, and runs under the entry's id at that point once the last hold is resumed.
   */
  pauseRecovery(): { settled: Promise<void>; resume(): void } {
    this.recoveryHolds++;
    let resumed = false;
    return {
      settled: this.recovery ?? Promise.resolve(),
      resume: () => {
        if (resumed) return;
        resumed = true;
        this.recoveryHolds--;
        if (this.recoveryHolds > 0 || !this.recoveryDeferred) return;
        this.recoveryDeferred = false;
        if (!this.disposed) this.runResync();
      },
    };
  }
  private recoveryHolds = 0;
  private recoveryDeferred = false;
  /** The recovery under way, from the timer firing until it ends (or hands over to the next attempt's timer). */
  private recovery: Promise<void> | null = null;
  private runResync(): void {
    const run: Promise<void> = this.resync().finally(() => {
      if (this.recovery === run) this.recovery = null;
    });
    this.recovery = run;
  }
  private startResync(): void {
    if (this.disposed || this.resyncing) return;
    this.resyncing = true;
    this.pending = [];
    for (const cancel of this.cancelParsing) cancel(new Error('Terminal is resynchronising'));
    this.cancelParsing.clear();
    this.notify();
    this.scheduleResync();
  }
  private scheduleResync(): void {
    this.bufferingReplay = false;
    this.pending = [];
    this.pendingChars = 0;
    this.recoveryOverflow = false;
    this.resyncTimer = setTimeout(() => this.runResync(), TERMINAL_RESYNC_PAUSE_MS);
  }
  private async resync(): Promise<void> {
    try {
      // reset() does not discard xterm's queued writes. Drain them before resetting the screen/parser.
      // No new live output is submitted during recovery, so the queue can catch up.
      await this.parse('');
      if (this.disposed) return;
      if (this.recoveryHolds > 0) {
        // The session is being moved: ask for it once the move is done, under the id it has then.
        this.recoveryDeferred = true;
        return;
      }
      this.term.reset();
      this.bufferingReplay = true;
      this.replaying = true;
      // Bound to the id asked for: after the await `this.id` could name another session.
      const id = this.id;
      const result = await this.bridge.open({
        chatId: id,
        cwd: this.info.cwd,
        cols: this.info.cols,
        rows: this.info.rows,
      });
      if (this.disposed) return;
      if (id !== this.id) {
        // Renamed while the open was in flight: the reply is for the old id. End a shell it started there (never the
        // one the entry now answers to) and recover again under the current id.
        if (result.created) void this.bridge.close(id).catch(() => {});
        this.replaying = false;
        this.scheduleResync();
        return;
      }
      if (result.created) {
        this.dispose();
        await this.bridge.close(id);
        return;
      }
      this.info = { ...result.info, status: this.exit ?? result.info.status };
      this.term.resize(result.info.cols, result.info.rows);
      await this.parse(result.replay);
      await this.parse(`\r\n${TERMINAL_SKIPPED_OUTPUT}\r\n`);
      if (this.disposed) return;
      if (this.recoveryOverflow) {
        this.replaying = false;
        this.scheduleResync();
        return;
      }
      this.seq = result.seq;
      this.resyncing = false;
      this.bufferingReplay = false;
      this.pendingChars = 0;
      this.replaying = false;
      this.drain();
      this.notify();
    } catch {
      if (!this.disposed) {
        this.replaying = false;
        this.scheduleResync();
      }
    }
  }
  private parse(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = (error: Error) => reject(error);
      this.cancelParsing.add(cancel);
      try {
        this.term.write(data, () => {
          this.cancelParsing.delete(cancel);
          resolve();
        });
      } catch (error) {
        this.cancelParsing.delete(cancel);
        reject(error);
      }
    });
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  mount(host: HTMLElement): () => void {
    if (this.term.element) host.append(this.term.element);
    else this.term.open(host);
    if (this.term.element) this.term.element.style.padding = `${TERMINAL_DOCK_PADDING}px`;
    let detached = false;
    const fitNow = () => {
      if (!detached && !this.disposed) {
        try {
          if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
          const size = this.fit.proposeDimensions();
          if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
          this.term.resize(
            Math.max(TERMINAL.minCols, Math.min(TERMINAL.maxCols, Math.floor(size.cols))),
            Math.max(TERMINAL.minRows, Math.min(TERMINAL.maxRows, Math.floor(size.rows))),
          );
        } catch {
          /* hidden layout */
        }
      }
    };
    fitNow();
    void waitForTerminalFont().then(fitNow);
    let timer: ReturnType<typeof setTimeout>;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(fitNow, 120);
          });
    observer?.observe(host);
    return () => {
      detached = true;
      clearTimeout(timer);
      observer?.disconnect();
      if (this.term.element?.parentElement === host) this.term.element.remove();
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.resyncTimer);
    for (const cancel of this.cancelParsing) cancel(new NoTerminalError());
    this.cancelParsing.clear();
    for (const off of this.offs) off();
    this.listeners.clear();
    this.term.dispose();
  }
}
export const terminalRegistry = new TerminalRegistry();
setLoadedTerminalRegistry(terminalRegistry);
