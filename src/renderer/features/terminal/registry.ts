// This module is reached only through the dock or a dynamic read import. Never export it from the eager barrel.
import {
  TERMINAL,
  type TerminalBridge,
  type TerminalDataEvent,
  type TerminalInfo,
  type TerminalReadAnswer,
  type TerminalReadRequest,
  type TerminalStatus,
} from '@shared/terminal';
import type { Id } from '@shared/types';
import { readTerminalBuffer } from './read';
import { splitTerminalWrite } from './write';
import { createFitAddon, createTerminal, TERMINAL_DOCK_PADDING, waitForTerminalFont } from './xterm';

class NoTerminalError extends Error {}

export class TerminalRegistry {
  private entries = new Map<Id, TerminalEntry>();
  private revisions = new Map<Id, number>();
  get(id: Id): TerminalEntry | undefined {
    return this.entries.get(id);
  }
  async attach(
    id: Id,
    bridge: TerminalBridge,
    options: { cwd: string | null; restart?: boolean; info?: TerminalInfo; host?: HTMLElement },
  ): Promise<TerminalEntry> {
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
        // Another attach may have completed while list was pending.
        if (this.get(id)) return this.attach(id, bridge, options);
        if (this.entries.size >= TERMINAL.maxSessions)
          throw new Error('Too many terminal sessions. End a terminal first.');
      }
      entry = new TerminalEntry(id, bridge);
      this.entries.set(id, entry);
      entry.ready = entry.open(options).catch((error: unknown) => {
        if (this.get(id) === entry) {
          entry?.dispose();
          this.entries.delete(id);
        }
        throw error;
      });
    }
    await entry.ready;
    return entry;
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

export class TerminalEntry {
  readonly term = createTerminal();
  readonly fit = createFitAddon();
  info!: TerminalInfo;
  ready: Promise<void> = Promise.resolve();
  disposed = false;
  private replaying = true;
  private untrusted = false;
  private cancelParsing = new Set<() => void>();
  private seq: number | null = null;
  private pending: TerminalDataEvent[] = [];
  private exit: TerminalStatus | null = null;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  constructor(
    readonly id: Id,
    private bridge: TerminalBridge,
  ) {
    this.term.loadAddon(this.fit);
    this.offs.push(
      bridge.onData((event) => {
        if (event.chatId !== id || this.disposed) return;
        this.pending.push(event);
        if (this.seq !== null) this.drain();
      }),
      bridge.onExit((event) => {
        if (event.chatId !== id) return;
        this.exit = event.status;
        if (this.info) this.info = { ...this.info, status: event.status };
        this.notify();
      }),
    );
    const input = this.term.onData((data) => {
      if (this.replaying || this.disposed || this.info?.status.state !== 'running') return;
      for (const piece of splitTerminalWrite(data)) bridge.write(id, piece);
    });
    const resize = this.term.onResize(({ cols, rows }) => {
      if (this.replaying || !this.info) return;
      this.info = { ...this.info, cols, rows };
      if (this.info.status.state === 'running') bridge.resize(id, cols, rows);
    });
    const selection = this.term.onSelectionChange(() => this.notify());
    this.offs.push(
      () => input.dispose(),
      () => resize.dispose(),
      () => selection.dispose(),
    );
  }
  async open(options: {
    cwd: string | null;
    restart?: boolean;
    info?: TerminalInfo;
    host?: HTMLElement;
  }): Promise<void> {
    const detach = options.host ? this.mount(options.host) : undefined;
    const size = { cols: this.term.cols, rows: this.term.rows };
    detach?.();
    const result = await this.bridge.open({
      chatId: this.id,
      cwd: options.cwd,
      cols: options.info?.cols ?? size.cols,
      rows: options.info?.rows ?? size.rows,
      ...(options.restart ? { restart: true } : {}),
    });
    if (options.info && result.created) {
      this.dispose();
      await this.bridge.close(this.id);
      throw new NoTerminalError();
    }
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
      if (this.untrusted) continue;
      try {
        this.term.write(event.data);
        this.seq = event.seq;
      } catch {
        // The missing event cannot be recovered without replay. Never answer from this buffer again.
        this.untrusted = true;
      }
    }
  }
  async flush(): Promise<void> {
    if (this.untrusted) throw new Error('Terminal output was dropped');
    await this.parse('');
    if (this.untrusted) throw new Error('Terminal output was dropped');
  }
  private parse(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new NoTerminalError());
      this.cancelParsing.add(cancel);
      try {
        this.term.write(data, () => {
          this.cancelParsing.delete(cancel);
          resolve();
        });
      } catch (error) {
        this.cancelParsing.delete(cancel);
        this.untrusted = true;
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
    for (const cancel of this.cancelParsing) cancel();
    this.cancelParsing.clear();
    for (const off of this.offs) off();
    this.listeners.clear();
    this.term.dispose();
  }
}
export const terminalRegistry = new TerminalRegistry();
