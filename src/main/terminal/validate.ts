// Payload checks for the terminal IPC channels (plan T1.5). The renderer is the app's own page, but this is still the
// boundary where a page gets to spawn a shell and write to it, so every value is checked here and nothing throws:
// each parser returns `null` for a payload it rejects.

import { TERMINAL, type TerminalReadRequest } from '@shared/terminal';
import type { Id } from '@shared/types';
import type { OpenParams } from './manager';

/** Chat ids are UUIDs; core accepts `[A-Za-z0-9_-]+`. */
const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PATH_LENGTH = 4_096;

export function parseChatId(value: unknown): Id | null {
  return typeof value === 'string' && CHAT_ID.test(value) && value !== 'index' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampDimension(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Finite numbers, floored and clamped to the limits; `null` for anything else. */
export function parseSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  const c = clampDimension(cols, TERMINAL.minCols, TERMINAL.maxCols);
  const r = clampDimension(rows, TERMINAL.minRows, TERMINAL.maxRows);
  return c === null || r === null ? null : { cols: c, rows: r };
}

/**
 * `{ chatId, cwd: string | null, cols, rows, restart?: boolean }`. A relative `cwd` is the manager's to replace with
 * home. `restart` is passed on only when true.
 */
export function parseOpenRequest(value: unknown): OpenParams | null {
  if (!isRecord(value)) return null;
  const chatId = parseChatId(value.chatId);
  if (!chatId) return null;
  const { cwd } = value;
  if (cwd !== null && (typeof cwd !== 'string' || cwd.length > MAX_PATH_LENGTH || cwd.includes('\0'))) return null;
  const size = parseSize(value.cols, value.rows);
  if (!size) return null;
  const { restart } = value;
  if (restart !== undefined && typeof restart !== 'boolean') return null;
  return restart ? { chatId, cwd, ...size, restart: true } : { chatId, cwd, ...size };
}

/** A string of at most `writeMaxBytes` UTF-8 bytes. Larger writes are refused whole, never cut. */
export function parseWriteData(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Every UTF-16 unit is at least one byte, so a longer string is over the cap without measuring it.
  if (value.length > TERMINAL.writeMaxBytes) return null;
  return Buffer.byteLength(value, 'utf8') <= TERMINAL.writeMaxBytes ? value : null;
}

function optionalLine(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** `{ startLine?, count? }`: positive integers. `count` above `readMaxLines` is capped later, not refused. */
export function parseReadRequest(value: unknown): TerminalReadRequest | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const startLine = optionalLine(value.startLine);
  const count = optionalLine(value.count);
  if (startLine === null || count === null) return null;
  const request: TerminalReadRequest = {};
  if (startLine !== undefined) request.startLine = startLine;
  if (count !== undefined) request.count = count;
  return request;
}
