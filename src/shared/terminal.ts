// Terminal contracts (docs/terminal-plan.md §4.1): limits, the shapes main and the renderer exchange over IPC, the
// preload bridge, and the IPC channel names.
//
// Who does what: Electron main owns the shell (a PTY) and a bounded copy of its raw output, and never interprets that
// output. The renderer owns the only terminal emulator (xterm.js), one per chat, kept alive while hidden. The model's
// reads are answered by the renderer from that emulator's buffer.

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
  /** Raw output main keeps per session, to replay into a new emulator after a window reload. */
  replayMaxBytes: 2 * 1024 * 1024,
  readDefaultLines: 200,
  readMaxLines: 1_000,
  /** Cap on the `read_terminal` tool's output, applied by the tool after redaction. The renderer never applies it. */
  readMaxBytes: 50 * 1024,
  /**
   * Largest text the renderer sends in one read answer. It enforces this after redacting, by dropping whole lines
   * from the start of the range (see `TerminalReadResult.truncated`).
   */
  readWireMaxChars: 2_600_000,
  /** Shells one app run may start. node-pty 1.1.0 leaks descriptors per spawn on macOS, so the total is capped. */
  maxSpawnsPerRun: 100,
  /** Input waiting to be read by the shell, per session. Writes beyond it are dropped. */
  pendingInputMaxBytes: 1024 * 1024,
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

/** Where a shell starts when no folder is given: home, or `~/Documents` (home when that is missing). */
export type TerminalDefaultFolder = 'home' | 'documents';

export interface TerminalOpenRequest {
  chatId: Id;
  /** null = `defaultFolder` */
  cwd: string | null;
  /**
   * Read only when `cwd` is null; absent = home. Main resolves the folder itself, so no path crosses IPC for it. Any
   * other value, or one sent with a string `cwd`, makes main refuse the whole request.
   */
  defaultFolder?: TerminalDefaultFolder;
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
  /**
   * The session's raw output so far, exactly as the shell wrote it, for a renderer whose emulator has none of it (a
   * new attach, or after a window reload). '' for a new session. At most `replayMaxBytes`: when older output was
   * dropped, it starts at a line break and `replayTruncated` is true. Write it into an emulator sized `info.cols` by
   * `info.rows`, and ignore what the emulator sends back while doing so (replayed queries would otherwise be
   * answered into the shell a second time).
   */
  replay: string;
  replayTruncated: boolean;
  /** Data events with `seq <= seq` are already in `replay`. */
  seq: number;
  created: boolean;
}
export interface TerminalDataEvent {
  chatId: Id;
  /** Increases by one per event within a session. */
  seq: number;
  /** Raw output, unmodified. */
  data: string;
}
export interface TerminalExitEvent {
  chatId: Id;
  status: TerminalStatus;
}

/**
 * Lines are logical lines (wrapped rows joined), 1-based from the top of the scrollback. Both omitted = the last
 * `readDefaultLines`. A `count` that runs past the end is clamped.
 */
export interface TerminalReadRequest {
  startLine?: number;
  count?: number;
}
/** Built by the renderer from its emulator's buffer (what the user sees, so a full-screen program's screen). */
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
   * Plain text: no escape codes and no control characters other than tab (an answer holding any other C0 control,
   * DEL or a C1 control is refused); whole lines only, joined by `\n` with no trailing one, so it has exactly
   * `endLine - startLine + 1` lines; trailing spaces trimmed. The renderer runs the pattern passes of
   * `redactSecrets` over the whole buffer before it selects the lines, so a secret that starts above the range (a
   * private-key block) is still caught, and nothing is ever cut before that redaction: a cut first can strip a key's
   * prefix and leave its body unmatched. The tool redacts again with the stored key.
   */
  text: string;
  /**
   * True when the redacted range was longer than `readWireMaxChars` and whole lines were dropped from its start
   * (`startLine` then names the first line kept). A single line longer than the limit is replaced by a one-line
   * placeholder. Never a cut inside a line.
   */
  truncated: boolean;
}
export type TerminalReadAnswer =
  | { ok: true; result: TerminalReadResult }
  | { ok: false; reason: 'no_terminal' | 'unavailable' };

export interface TerminalBridge {
  /**
   * Creates the chat's session, or attaches to the existing one (running or exited; see `restart`). Rejects with a
   * user-readable message when `maxSessions` or `maxSpawnsPerRun` is reached. Subscribe to `onData` before calling
   * it: events above the result's `seq` can arrive before it resolves.
   */
  open(req: TerminalOpenRequest): Promise<TerminalOpenResult>;
  /** The sessions main holds, running or exited. Lets the renderer find sessions that survived a window reload. */
  list(): Promise<TerminalInfo[]>;
  /** At most `writeMaxBytes` UTF-8 bytes per call; a larger write is dropped, so split a big paste. */
  write(chatId: Id, data: string): void;
  resize(chatId: Id, cols: number, rows: number): void;
  /** Ends the shell and forgets the session. Resolves when there is none. */
  close(chatId: Id): Promise<void>;
  /**
   * Moves the New Chat screen's session (`draftId`, always `DRAFT_CHAT_ID`) to the chat just created from it, with its
   * replay and `seq`. True when a session moved; false when there was nothing to move or `chatId` already has a
   * session (then neither is touched). Never starts a shell. Later data and exit events carry `chatId`.
   */
  adopt(draftId: Id, chatId: Id): Promise<boolean>;
  onData(listener: (e: TerminalDataEvent) => void): () => void;
  onExit(listener: (e: TerminalExitEvent) => void): () => void;
}

export const TERMINAL_IPC = {
  open: 'openvern:terminal:open', // invoke
  list: 'openvern:terminal:list', // invoke
  close: 'openvern:terminal:close', // invoke
  adopt: 'openvern:terminal:adopt', // invoke
  write: 'openvern:terminal:write', // send
  resize: 'openvern:terminal:resize', // send
  data: 'openvern:terminal:data', // main → renderer
  exit: 'openvern:terminal:exit', // main → renderer
} as const;
