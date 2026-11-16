// Test doubles for the terminal dock: a recording stand-in for xterm (the real one needs a canvas and real layout, which
// jsdom has not got) and a fake `TerminalBridge` that behaves like main's session table. Not part of the app bundle.
//
// A test file wires the xterm half in with
//   vi.mock('@xterm/xterm', () => import('./test-fakes'));
//   vi.mock('@xterm/addon-fit', () => import('./test-fakes'));
// and gives the app the bridge with `installTerminalBridge`.

import type {
  TerminalBridge,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalOpenRequest,
  TerminalOpenResult,
  TerminalStatus,
} from '@shared/terminal';
import type { Id } from '@shared/types';

type Listener<T> = (value: T) => void;

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => void listeners.delete(listener) };
}

/** The `Terminal` export of `@xterm/xterm`. Records what the dock does to it; test controls simulate what xterm reports. */
export class Terminal {
  /** Every instance built since the last `reset`, oldest first. */
  static instances: Terminal[] = [];

  static reset(): void {
    Terminal.instances = [];
  }

  static last(): Terminal {
    const term = Terminal.instances.at(-1);
    if (!term) throw new Error('no fake terminal was created');
    return term;
  }

  readonly options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  /** The element xterm opens into the host. */
  element: HTMLDivElement | null = null;
  /** The focusable element inside the terminal, like xterm's helper textarea. */
  textarea: HTMLTextAreaElement | null = null;
  /** Everything written to the screen, in order. */
  readonly writes: string[] = [];
  disposed = false;
  buffer = {
    active: { length: 1, getLine: () => ({ isWrapped: false, translateToString: () => this.writes.join('') }) },
  };

  private selection: string | null = null;
  private readonly dataListeners = new Set<Listener<string>>();
  private readonly resizeListeners = new Set<Listener<{ cols: number; rows: number }>>();
  private readonly selectionListeners = new Set<Listener<void>>();

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
    Terminal.instances.push(this);
  }

  loadAddon(addon: { activate(term: Terminal): void }): void {
    addon.activate(this);
  }

  open(host: HTMLElement): void {
    this.element = document.createElement('div');
    this.textarea = document.createElement('textarea');
    this.textarea.setAttribute('aria-label', 'Terminal input');
    this.element.append(this.textarea);
    host.append(this.element);
  }

  write(data: string, callback?: () => void): void {
    if (data) this.writes.push(data);
    callback?.();
  }

  reset(): void {
    this.writes.length = 0;
  }

  focus(): void {
    this.textarea?.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.element?.remove();
  }

  onData(listener: Listener<string>): { dispose(): void } {
    return subscribe(this.dataListeners, listener);
  }

  onResize(listener: Listener<{ cols: number; rows: number }>): { dispose(): void } {
    return subscribe(this.resizeListeners, listener);
  }

  onSelectionChange(listener: Listener<void>): { dispose(): void } {
    return subscribe(this.selectionListeners, listener);
  }

  hasSelection(): boolean {
    return this.selection !== null && this.selection !== '';
  }

  getSelection(): string {
    return this.selection ?? '';
  }

  clearSelection(): void {
    this.select(null);
  }

  /** Simulates typing: what xterm reports through `onData`. */
  type(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  /** Simulates a selection (or clears it with `null`). */
  select(text: string | null): void {
    this.selection = text;
    for (const listener of this.selectionListeners) listener(undefined);
  }

  /** Simulates a size change, as xterm reports it after a fit. */
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    for (const listener of this.resizeListeners) listener({ cols, rows });
  }
}

/** The `FitAddon` export of `@xterm/addon-fit`: `fit()` resizes the terminal to `FitAddon.size` when one is set. */
export class FitAddon {
  /** The size the next fit gives the terminal. `null` = leave it alone. */
  static size: { cols: number; rows: number } | null = null;
  static fits = 0;

  static reset(): void {
    FitAddon.size = null;
    FitAddon.fits = 0;
  }

  private terminal: Terminal | null = null;

  activate(term: Terminal): void {
    this.terminal = term;
  }

  dispose(): void {
    this.terminal = null;
  }

  proposeDimensions(): { cols: number; rows: number } | undefined {
    FitAddon.fits++;
    return FitAddon.size ?? undefined;
  }

  fit(): void {
    FitAddon.fits++;
    if (this.terminal && FitAddon.size) this.terminal.resize(FitAddon.size.cols, FitAddon.size.rows);
  }
}

interface FakeSession {
  info: TerminalInfo;
  /** Everything written so far, as the replay would hold it. */
  replay: string;
  /** Sequence number of the last data event. */
  seq: number;
}

/** A scripted `TerminalBridge`. Sessions are keyed by chat, like main; every call is recorded. */
export class FakeTerminalBridge implements TerminalBridge {
  readonly opens: TerminalOpenRequest[] = [];
  readonly writes: { chatId: Id; data: string }[] = [];
  readonly resizes: { chatId: Id; cols: number; rows: number }[] = [];
  readonly closes: Id[] = [];
  readonly adopts: { from: Id; to: Id }[] = [];
  /** What the next `adopt` does instead of moving: `reject` fails the call, `refuse` answers false. */
  adoptMode: 'move' | 'refuse' | 'reject' = 'move';

  private sessions = new Map<Id, FakeSession>();
  private gate: Promise<void> | null = null;
  private readonly dataListeners = new Set<Listener<TerminalDataEvent>>();
  private readonly exitListeners = new Set<Listener<TerminalExitEvent>>();

  /** Holds every `open` until the returned function is called. */
  holdOpens(): () => void {
    let release: () => void = () => {};
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.gate = null;
      release();
    };
  }

  /**
   * Like main, the replay is taken when `open` is handled; a held gate only delays the reply. Data that comes in while
   * the reply is delayed is therefore newer than the replay the renderer receives.
   */
  open(req: TerminalOpenRequest): Promise<TerminalOpenResult> {
    this.opens.push(req);
    const result = this.attach(req);
    const gate = this.gate;
    return gate ? gate.then(() => result) : Promise.resolve(result);
  }

  private attach(req: TerminalOpenRequest): TerminalOpenResult {
    const existing = this.sessions.get(req.chatId);
    // Main attaches to a running session always, and to an exited one unless `restart` asks for a fresh shell.
    if (existing && (existing.info.status.state === 'running' || req.restart !== true)) {
      return {
        info: existing.info,
        replay: existing.replay,
        seq: existing.seq,
        created: false,
        replayTruncated: false,
      };
    }
    // No session, or an exited one with `restart`: main starts a new shell.
    const session: FakeSession = {
      info: {
        chatId: req.chatId,
        shell: 'zsh',
        cwd: req.cwd ?? (req.defaultFolder === 'documents' ? '/home/you/Documents' : '/home/you'),
        cols: req.cols,
        rows: req.rows,
        status: { state: 'running' },
      },
      replay: '',
      seq: 0,
    };
    this.sessions.set(req.chatId, session);
    return { info: session.info, replay: '', seq: 0, created: true, replayTruncated: false };
  }

  write(chatId: Id, data: string): void {
    this.writes.push({ chatId, data });
  }

  resize(chatId: Id, cols: number, rows: number): void {
    this.resizes.push({ chatId, cols, rows });
  }

  async list(): Promise<TerminalInfo[]> {
    return [...this.sessions.values()].map((s) => s.info);
  }

  async close(chatId: Id): Promise<void> {
    this.closes.push(chatId);
    this.sessions.delete(chatId);
  }

  /** Like main: moves `from`'s session to `to` unless there is none or `to` has one; later events carry `to`. */
  async adopt(from: Id, to: Id): Promise<boolean> {
    this.adopts.push({ from, to });
    if (this.adoptMode === 'reject') throw new Error('terminal: invalid request');
    if (this.adoptMode === 'refuse') return false;
    const session = this.sessions.get(from);
    if (!session || this.sessions.has(to)) return false;
    this.sessions.delete(from);
    session.info = { ...session.info, chatId: to };
    this.sessions.set(to, session);
    return true;
  }

  onData(listener: Listener<TerminalDataEvent>): () => void {
    return subscribe(this.dataListeners, listener).dispose;
  }

  onExit(listener: Listener<TerminalExitEvent>): () => void {
    return subscribe(this.exitListeners, listener).dispose;
  }

  /** An existing session, as if main had started it earlier (a reload, or a dock that was hidden). */
  seed(chatId: Id, opts: { replay?: string; seq?: number } = {}): void {
    this.sessions.set(chatId, {
      info: {
        chatId,
        shell: 'zsh',
        cwd: '/home/you',
        cols: 80,
        rows: 24,
        status: { state: 'running' },
      },
      replay: opts.replay ?? '',
      seq: opts.seq ?? 0,
    });
  }

  /**
   * A data event from the shell. `seq` defaults to the next number. The session's replay only grows for a newer
   * sequence number, which is what main does too.
   */
  emitData(chatId: Id, data: string, seq?: number): void {
    const session = this.sessions.get(chatId);
    const nextSeq = seq ?? (session?.seq ?? 0) + 1;
    if (session && nextSeq > session.seq) {
      session.seq = nextSeq;
      session.replay += data;
    }
    const event: TerminalDataEvent = { chatId, seq: nextSeq, data };
    for (const listener of this.dataListeners) listener(event);
  }

  /** The shell ended (or its state changed). */
  emitExit(chatId: Id, status: TerminalStatus): void {
    const session = this.sessions.get(chatId);
    if (session) session.info = { ...session.info, status };
    for (const listener of this.exitListeners) listener({ chatId, status });
  }

  hasSession(chatId: Id): boolean {
    return this.sessions.has(chatId);
  }
}

/** Gives the app a terminal bridge, as the Electron preload does. `null` removes it (the web build). */
export function installTerminalBridge(bridge: TerminalBridge | null): void {
  if (bridge === null) {
    delete window.openvern;
    return;
  }
  window.openvern = { isElectron: true, pickDirectory: async () => null, terminal: bridge };
}

/** Clears the xterm fakes. Call from `beforeEach`. */
export function resetTerminalFakes(): void {
  Terminal.reset();
  FitAddon.reset();
}
