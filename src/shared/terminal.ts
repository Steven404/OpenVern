// Terminal contracts (docs/terminal-plan.md §4.1): limits, the shapes main and the renderer exchange over IPC, the
// preload bridge, and the IPC channel names. The PTY lives in Electron main; the renderer reaches it through
// `window.openvern.terminal`.

import type { Id } from './types';

export const TERMINAL = {
  scrollbackLines: 5_000,
  maxSessions: 8,
  defaultCols: 80,
  defaultRows: 24,
  minCols: 20,
  maxCols: 500,
  minRows: 5,
  maxRows: 200,
  /** Largest `write` payload accepted in one IPC message. */
  writeMaxBytes: 64 * 1024,
  readDefaultLines: 200,
  readMaxLines: 1_000,
  /** Cap on the `read_terminal` tool's output, applied by the tool after redaction. Main never applies it. */
  readMaxBytes: 50 * 1024,
  /** Largest text main can send: the whole buffer, (scrollbackLines + maxRows) * maxCols characters. */
  readWireMaxChars: 2_600_000,
  /** Largest accepted body of a read answer (the text as JSON, at most 3 bytes per character, plus the rest). */
  readWireMaxBytes: 8 * 1024 * 1024,
  /** How long the backend waits for the renderer's answer. */
  readTimeoutMs: 10_000,
  selectionMaxChars: 20_000,
  dockDefaultHeight: 280,
  dockMinHeight: 160,
} as const;

export type TerminalStatus = { state: 'running' } | { state: 'exited'; exitCode: number | null; signal: number | null };

export interface TerminalInfo {
  chatId: Id;
  /** Basename of the shell, e.g. `zsh`. */
  shell: string;
  /** The folder the shell started in. Not updated after `cd`. */
  cwd: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
}

export interface TerminalOpenRequest {
  chatId: Id;
  /** null = home */
  cwd: string | null;
  cols: number;
  rows: number;
  /**
   * True = replace an exited session with a fresh shell (the Restart button). Without it, opening a chat whose shell
   * has exited attaches to it, so the exit code and the scrollback stay visible. Ignored while the shell is running.
   */
  restart?: boolean;
}
export interface TerminalOpenResult {
  info: TerminalInfo;
  /** Serialized screen and scrollback of an existing session; '' for a new one. */
  snapshot: string;
  /** Data events with `seq <= seq` are already in the snapshot. */
  seq: number;
  created: boolean;
}
export interface TerminalDataEvent {
  chatId: Id;
  seq: number;
  data: string;
}
export interface TerminalExitEvent {
  chatId: Id;
  status: TerminalStatus;
}

/** Lines are 1-based from the top of the scrollback. Both omitted = the last `readDefaultLines`. */
/**
 * Lines are logical lines (wrapped rows joined), 1-based from the top of the scrollback. Both omitted = the last
 * `readDefaultLines`. A `count` that runs past the end is clamped.
 */
export interface TerminalReadRequest {
  startLine?: number;
  count?: number;
}
export interface TerminalReadResult {
  info: TerminalInfo;
  /** Logical lines in the buffer, without trailing blank lines. */
  totalLines: number;
  /**
   * `1 <= startLine <= endLine <= totalLines`, and at most `readMaxLines` lines. An empty buffer, or a `startLine`
   * past the end, gives `startLine: 0`, `endLine: 0` and `text: ''`.
   */
  startLine: number;
  endLine: number;
  /**
   * Plain text, no escape codes; whole lines only; trailing spaces trimmed. Never cut by size: a cut before
   * redaction can strip a key's prefix and leave its body unmatched. Main runs the pattern passes of
   * `redactSecrets` over the whole buffer before it selects the lines, so a secret that starts above the range
   * (a private-key block) is still caught. The tool redacts again with the stored key.
   */
  text: string;
  /** Always false from main. Kept so the answer's shape is stable. */
  truncated: boolean;
}
export type TerminalReadAnswer =
  | { ok: true; result: TerminalReadResult }
  | { ok: false; reason: 'no_terminal' | 'unavailable' };

export interface TerminalBridge {
  /**
   * Creates the chat's session, or attaches to the existing one (running or exited; see `restart`). Rejects when
   * `maxSessions` is reached. Subscribe to `onData` before calling it: events above the result's `seq` can arrive
   * before it resolves.
   */
  open(req: TerminalOpenRequest): Promise<TerminalOpenResult>;
  /** At most `writeMaxBytes` UTF-8 bytes per call; a larger write is dropped, so split a big paste. */
  write(chatId: Id, data: string): void;
  resize(chatId: Id, cols: number, rows: number): void;
  read(chatId: Id, req: TerminalReadRequest): Promise<TerminalReadAnswer>;
  /** Kills the shell and forgets the session. Resolves when there is none. */
  close(chatId: Id): Promise<void>;
  onData(listener: (e: TerminalDataEvent) => void): () => void;
  onExit(listener: (e: TerminalExitEvent) => void): () => void;
}

export const TERMINAL_IPC = {
  open: 'openvern:terminal:open', // invoke
  read: 'openvern:terminal:read', // invoke
  close: 'openvern:terminal:close', // invoke
  write: 'openvern:terminal:write', // send
  resize: 'openvern:terminal:resize', // send
  data: 'openvern:terminal:data', // main → renderer
  exit: 'openvern:terminal:exit', // main → renderer
} as const;
