// Payload checks for the terminal IPC channels (plan T1.5). The renderer is the app's own page, but this is still the
// boundary where a page gets to spawn a shell and write to it, so every value is checked here and nothing throws:
// each parser returns `null` for a payload it rejects.

import { DRAFT_CHAT_ID } from '@shared/constants';
import { TERMINAL } from '@shared/terminal';
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
 * `{ chatId, cwd: string | null, defaultFolder?: 'home' | 'documents', cols, rows, restart?: boolean }`. A relative
 * `cwd` is the manager's to replace with home. `defaultFolder` is allowed only with a null `cwd`; any other value, or
 * one sent with a string `cwd`, refuses the whole request rather than falling back. It is passed on only when
 * `'documents'` (home is the default), and `restart` only when true.
 */
export function parseOpenRequest(value: unknown): OpenParams | null {
  if (!isRecord(value)) return null;
  const chatId = parseChatId(value.chatId);
  if (!chatId) return null;
  const { cwd } = value;
  if (cwd !== null && (typeof cwd !== 'string' || cwd.length > MAX_PATH_LENGTH || cwd.includes('\0'))) return null;
  const { defaultFolder } = value;
  if (defaultFolder !== undefined) {
    if (defaultFolder !== 'home' && defaultFolder !== 'documents') return null;
    if (cwd !== null) return null;
  }
  const size = parseSize(value.cols, value.rows);
  if (!size) return null;
  const { restart } = value;
  if (restart !== undefined && typeof restart !== 'boolean') return null;
  return {
    chatId,
    cwd,
    ...(defaultFolder === 'documents' ? { defaultFolder } : {}),
    ...size,
    ...(restart ? { restart: true } : {}),
  };
}

/**
 * `adopt(from, to)`: moving the New Chat screen's session to the chat created from it. Only `DRAFT_CHAT_ID` can be
 * moved, and never onto itself or another draft; both must be valid chat ids. `null` refuses.
 */
export function parseAdopt(from: unknown, to: unknown): { from: Id; to: Id } | null {
  const source = parseChatId(from);
  const target = parseChatId(to);
  if (source === null || target === null) return null;
  if (source !== DRAFT_CHAT_ID || target === DRAFT_CHAT_ID) return null;
  return { from: source, to: target };
}

/** A string of at most `writeMaxBytes` UTF-8 bytes. Larger writes are refused whole, never cut. */
export function parseWriteData(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Every UTF-16 unit is at least one byte, so a longer string is over the cap without measuring it.
  if (value.length > TERMINAL.writeMaxBytes) return null;
  return Buffer.byteLength(value, 'utf8') <= TERMINAL.writeMaxBytes ? value : null;
}
