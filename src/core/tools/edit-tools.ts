// Edit tools: `edit_file`, `write_file`, `delete_file`. They never touch the disk themselves. In Review they stage
// content in the chat's change set through `ctx.changes`, which the user later reviews and applies; in Auto they hand
// it to `ctx.changes.write`, which re-checks everything under the file's write lock and writes it.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { LIMITS } from '@shared/constants';
import type { EditMode, FileChange } from '@shared/types';
import { z } from 'zod';
import {
  alreadyProposedForDeletionText,
  autoNoChangeText,
  autoPendingText,
  changeFailedText,
  contentTooLargeText,
  createdText,
  createResultText,
  deletedText,
  deleteResultText,
  EDITING_UNAVAILABLE_TEXT,
  editedTooLargeText,
  editNoChangeText,
  editResultText,
  editToolDescriptions,
  noChangeText,
  proposedForDeletionText,
  sourceTooLargeText,
  writeNoChangeText,
  writtenEditText,
} from '../agent/edit-mode';
import { CoreError } from '../errors';
import { redactSecrets } from '../security/redact';
import { type ResolveResult, resolveForWrite, type SandboxOptions } from './sandbox';
import type { EditToolName, Tool, ToolChanges, ToolContext, ToolResult } from './types';
import { abortedResult, displayPath, fail, parseArgs, succeed, toParameters } from './util';

const PLACEHOLDER = '«redacted:';
const MAX_MATCH_LINES_LISTED = 10;

/**
 * The file a change is based on. `hash` is the sha256 of the bytes read from disk ('' when the file is missing, or
 * when the text came from a pending proposal): in Auto the change service refuses the write unless the file still
 * has exactly these bytes.
 */
type Current =
  | { state: 'text'; content: string; hash: string }
  | { state: 'missing'; hash: '' }
  /** Staged for deletion; still on disk. Review only. */
  | { state: 'deleted' }
  | { state: 'binary'; hash: string }
  | { state: 'other'; message: string };

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The file as the model sees it. Review: staged content first, then the disk. Auto: the disk only (a path with a
 * pending proposal is refused before this runs).
 */
async function loadCurrent(
  rel: string,
  abs: string,
  exists: boolean,
  changes: ToolChanges,
  signal: AbortSignal,
): Promise<Current> {
  if (changes.mode === 'review') {
    const staged = await changes.read(rel);
    if (staged?.kind === 'staged') return { state: 'text', content: staged.content, hash: '' };
    if (staged?.kind === 'deleted') return { state: 'deleted' };
  }
  if (!exists) return { state: 'missing', hash: '' };
  try {
    const info = await stat(abs);
    if (info.isDirectory()) return { state: 'other', message: `${rel} is a directory, not a file.` };
    if (!info.isFile()) return { state: 'other', message: `${rel} is not a regular file.` };
    // The change service enforces the same limit (in Auto, under the write lock); this one keeps the bytes out of
    // memory in the first place, in both modes.
    if (info.size > LIMITS.editSourceMaxBytes) {
      return { state: 'other', message: sourceTooLargeText(changes.mode, rel, info.size) };
    }
    const buf = await readFile(abs, { signal });
    const hash = sha256(buf);
    if (buf.includes(0)) return { state: 'binary', hash };
    try {
      return { state: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(buf), hash };
    } catch {
      return { state: 'binary', hash };
    }
  } catch (e) {
    return { state: 'other', message: `Cannot read ${rel}: ${(e as NodeJS.ErrnoException).code ?? 'unknown error'}` };
  }
}

/** Validation shared by `edit_file` and `write_file` for text that is about to be staged. */
function checkNewContent(content: string, what: string): string | null {
  if (content.includes(PLACEHOLDER)) {
    return `${what} contains a «redacted:…» placeholder. Placeholders stand for secret values you cannot see, and writing one would destroy the real value. Leave that part out of the change, or use edit_file around it so the secret is not touched.`;
  }
  if (content.includes('\0')) return `${what} contains a NUL byte; only text files can be written.`;
  return null;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function diffExcerpt(file: FileChange): { excerpt: string[]; omitted: number } {
  const all: string[] = [];
  for (const h of file.hunks) {
    all.push(
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.header ? ` ${h.header}` : ''}`,
      ...h.lines,
    );
  }
  const cap = LIMITS.editResultDiffLines;
  return { excerpt: all.slice(0, cap), omitted: Math.max(0, all.length - cap) };
}

/**
 * Hands the change to the change service: staged as a proposal in Review, written to disk in Auto. A refusal comes
 * back as a `CoreError` whose message is meant for the model, so it becomes the tool's failure text.
 */
async function commitChange(
  changes: ToolChanges,
  rel: string,
  content: string | null,
  auto: { tool: EditToolName; baseHash: string },
): Promise<{ ok: true; file: FileChange | null } | { ok: false; message: string }> {
  try {
    const { file } =
      changes.mode === 'auto' ? await changes.write(rel, content, auto) : await changes.stage(rel, content);
    return { ok: true, file };
  } catch (e) {
    if (e instanceof CoreError) return { ok: false, message: e.message };
    return { ok: false, message: changeFailedText(changes.mode, rel) };
  }
}

/** Common start of every edit tool: arguments, change set, sandbox. */
async function prepare<S extends z.ZodType>(
  schema: S,
  rawArgs: unknown,
  ctx: ToolContext,
  opts: SandboxOptions,
  pathOf: (data: z.output<S>) => string,
): Promise<
  | { ok: true; data: z.output<S>; changes: ToolChanges; res: Extract<ResolveResult, { ok: true }>; summary: string }
  | { ok: false; result: ToolResult }
> {
  const parsed = parseArgs(schema, rawArgs);
  if (!parsed.ok) return { ok: false, result: fail(parsed.message, 'invalid arguments') };
  const relPath = pathOf(parsed.data);
  const summary = displayPath(relPath);
  if (!ctx.changes) return { ok: false, result: fail(EDITING_UNAVAILABLE_TEXT, summary) };
  if (ctx.signal.aborted) return { ok: false, result: abortedResult(summary) };
  const res = await resolveForWrite(ctx.projectRoot, relPath, opts);
  if (!res.ok) return { ok: false, result: fail(res.message, summary) };
  if (res.rel === '') return { ok: false, result: fail('The project root is a directory, not a file.', summary) };
  // Auto never writes over a pending Review proposal: the user hasn't decided on it, and a write based on its text
  // would apply it without review. The change service refuses it too (folded spellings included).
  if (ctx.changes.mode === 'auto' && (await ctx.changes.read(res.rel)) !== null) {
    return { ok: false, result: fail(autoPendingText(res.rel), summary) };
  }
  return { ok: true, data: parsed.data, changes: ctx.changes, res, summary };
}

/** The tool result for a change that reached the disk (Auto). `file` is this write's own diff. */
function writtenResult(
  file: FileChange | null,
  rel: string,
  content: string | null,
  lines: number | null,
  summary: string,
  replacements?: number,
): ToolResult {
  if (!file) return succeed(autoNoChangeText(rel), summary);
  if (file.kind === 'delete') return succeed(deletedText(rel, lines), summary);
  if (file.kind === 'create') return succeed(createdText(rel, lineCount(content ?? '')), summary);
  const { excerpt, omitted } = diffExcerpt(file);
  return succeed(
    writtenEditText({
      path: rel,
      add: file.add,
      del: file.del,
      excerpt,
      omitted,
      ...(replacements !== undefined ? { replacements } : {}),
      ...(file.tooLarge ? { tooLarge: true } : {}),
    }),
    summary,
  );
}

function blockedByState(cur: Current, rel: string, summary: string): ToolResult | null {
  if (cur.state === 'binary') {
    return fail(`${rel} is a binary file (or not valid UTF-8) and cannot be edited or overwritten.`, summary);
  }
  if (cur.state === 'other') return fail(cur.message, summary);
  return null;
}

// ── edit_file ────────────────────────────────────────────────────────────────────────────────────

const editSchema = z.object({
  path: z.string().min(1).describe('File to edit, relative to the project root (e.g. "src/index.ts"). It must exist.'),
  old_string: z
    .string()
    .describe(
      'The exact text to replace, copied from the file (whitespace and indentation included). Must be unique in the file unless replace_all is true.',
    ),
  new_string: z.string().describe('The text to put in its place. Must differ from old_string.'),
  replace_all: z
    .boolean()
    .default(false)
    .describe('Replace every occurrence of old_string (e.g. to rename a variable). Defaults to false.'),
});

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** `editMode` picks the description the model reads; what the tool does follows the turn's `ctx.changes.mode`. */
export interface EditToolOptions extends SandboxOptions {
  editMode?: EditMode;
}

export function createEditFileTool(opts: EditToolOptions = {}): Tool {
  return {
    spec: {
      name: 'edit_file',
      description: editToolDescriptions(opts.editMode).edit,
      parameters: toParameters(editSchema),
    },

    async run(rawArgs, ctx) {
      const prep = await prepare(editSchema, rawArgs, ctx, opts, (d) => d.path);
      if (!prep.ok) return prep.result;
      const { data, changes, res, summary } = prep;
      const { old_string: oldString, new_string: newString, replace_all: replaceAll } = data;
      const rel = res.rel;

      if (oldString === '') {
        return fail(
          'old_string is empty. To create a file or replace a whole file use write_file; to edit, pass the exact text to replace.',
          summary,
        );
      }
      if (oldString === newString)
        return fail('old_string and new_string are identical; there is nothing to change.', summary);
      const bad = checkNewContent(newString, 'new_string');
      if (bad) return fail(bad, summary);

      const cur = await loadCurrent(rel, res.abs, res.exists, changes, ctx.signal);
      if (ctx.signal.aborted) return abortedResult(summary);
      if (cur.state === 'missing') {
        return fail(`File not found: ${rel}. To create a new file use write_file.`, summary);
      }
      if (cur.state === 'deleted') {
        return fail(proposedForDeletionText(rel), summary);
      }
      const blocked = blockedByState(cur, rel, summary);
      if (blocked) return blocked;
      if (cur.state !== 'text') return fail(`Cannot edit ${rel}.`, summary);

      // Models send "\n"; a file that uses CRLF throughout is matched as LF and written back as CRLF.
      const crlf = cur.content.includes('\r\n') && !/(^|[^\r])\n/.test(cur.content);
      const text = crlf ? cur.content.replaceAll('\r\n', '\n') : cur.content;
      const oldNorm = crlf ? oldString.replaceAll('\r\n', '\n') : oldString;
      const newNorm = crlf ? newString.replaceAll('\r\n', '\n') : newString;

      const found = occurrences(text, oldNorm);
      if (found.length === 0) {
        if (oldString.includes(PLACEHOLDER)) {
          return fail(
            'old_string contains a «redacted:…» placeholder. Those stand for secret values you cannot see, so they cannot be matched. Choose old_string from the lines around the secret instead.',
            summary,
          );
        }
        const redactedText = redactSecrets(text, { known: ctx.knownSecrets }).text;
        if (redactedText !== text && occurrences(redactedText, oldNorm).length > 0) {
          return fail(
            'old_string would have to include a secret value that is shown redacted, so it cannot be matched. Choose old_string from the lines around the secret and leave the secret untouched.',
            summary,
          );
        }
        return fail(
          `old_string was not found in ${rel}. Re-read the file and copy the text exactly: whitespace, indentation and line breaks must match. Redacted values cannot be matched.`,
          summary,
        );
      }
      if (found.length > 1 && !replaceAll) {
        const lines = found.map((i) => lineOf(text, i));
        const shown = lines.slice(0, MAX_MATCH_LINES_LISTED).join(', ');
        const more =
          lines.length > MAX_MATCH_LINES_LISTED ? `, ... (${lines.length - MAX_MATCH_LINES_LISTED} more)` : '';
        return fail(
          `old_string matches ${found.length} places in ${rel} (lines ${shown}${more}). Include more surrounding lines to make it unique, or set replace_all to true to change every match.`,
          summary,
        );
      }

      let next = replaceAll ? text.split(oldNorm).join(newNorm) : text.replace(oldNorm, () => newNorm);
      if (crlf) next = next.replaceAll('\n', '\r\n');
      const size = Buffer.byteLength(next);
      if (size > LIMITS.writeFileMaxBytes) return fail(editedTooLargeText(changes.mode, size), summary);

      const staged = await commitChange(changes, rel, next, { tool: 'edit_file', baseHash: cur.hash });
      if (!staged.ok) return fail(staged.message, summary);
      if (changes.mode === 'auto') return writtenResult(staged.file, rel, next, null, summary, found.length);
      if (!staged.file) return succeed(editNoChangeText(changes.mode, rel), summary);
      const { excerpt, omitted } = diffExcerpt(staged.file);
      return succeed(
        editResultText({
          path: rel,
          add: staged.file.add,
          del: staged.file.del,
          excerpt,
          omitted,
          replacements: found.length,
        }),
        summary,
      );
    },
  };
}

// ── write_file ───────────────────────────────────────────────────────────────────────────────────

const writeSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('File to create or overwrite, relative to the project root (e.g. "src/new-module.ts").'),
  content: z.string().describe('The complete content of the file.'),
});

export function createWriteFileTool(opts: EditToolOptions = {}): Tool {
  return {
    spec: {
      name: 'write_file',
      description: editToolDescriptions(opts.editMode).write,
      parameters: toParameters(writeSchema),
    },

    async run(rawArgs, ctx) {
      const prep = await prepare(writeSchema, rawArgs, ctx, opts, (d) => d.path);
      if (!prep.ok) return prep.result;
      const { data, changes, res, summary } = prep;
      const { content } = data;
      const rel = res.rel;

      const bad = checkNewContent(content, 'content');
      if (bad) return fail(bad, summary);
      const size = Buffer.byteLength(content);
      if (size > LIMITS.writeFileMaxBytes) return fail(contentTooLargeText(changes.mode, size), summary);

      const cur = await loadCurrent(rel, res.abs, res.exists, changes, ctx.signal);
      if (ctx.signal.aborted) return abortedResult(summary);
      const blocked = blockedByState(cur, rel, summary);
      if (blocked) return blocked;
      if (cur.state === 'text' && cur.content === content) {
        return succeed(changes.mode === 'auto' ? autoNoChangeText(rel) : noChangeText(rel), summary);
      }

      const baseHash = cur.state === 'text' || cur.state === 'missing' ? cur.hash : '';
      const staged = await commitChange(changes, rel, content, { tool: 'write_file', baseHash });
      if (!staged.ok) return fail(staged.message, summary);
      if (changes.mode === 'auto') return writtenResult(staged.file, rel, content, null, summary);
      if (!staged.file) return succeed(writeNoChangeText(changes.mode, rel), summary);
      if (staged.file.kind === 'create') return succeed(createResultText(rel, lineCount(content)), summary);
      const { excerpt, omitted } = diffExcerpt(staged.file);
      return succeed(
        editResultText({ path: rel, add: staged.file.add, del: staged.file.del, excerpt, omitted }),
        summary,
      );
    },
  };
}

// ── delete_file ──────────────────────────────────────────────────────────────────────────────────

const deleteSchema = z.object({
  path: z.string().min(1).describe('File to delete, relative to the project root. Directories cannot be deleted.'),
});

export function createDeleteFileTool(opts: EditToolOptions = {}): Tool {
  return {
    spec: {
      name: 'delete_file',
      description: editToolDescriptions(opts.editMode).delete,
      parameters: toParameters(deleteSchema),
    },

    async run(rawArgs, ctx) {
      const prep = await prepare(deleteSchema, rawArgs, ctx, opts, (d) => d.path);
      if (!prep.ok) return prep.result;
      const { changes, res, summary } = prep;
      const rel = res.rel;

      const cur = await loadCurrent(rel, res.abs, res.exists, changes, ctx.signal);
      if (ctx.signal.aborted) return abortedResult(summary);
      if (cur.state === 'missing') return fail(`File not found: ${rel}. Nothing to delete.`, summary);
      if (cur.state === 'deleted') return succeed(alreadyProposedForDeletionText(rel), summary);
      if (cur.state === 'other') return fail(cur.message, summary);

      const lines = cur.state === 'text' ? lineCount(cur.content) : null;
      const staged = await commitChange(changes, rel, null, { tool: 'delete_file', baseHash: cur.hash });
      if (!staged.ok) return fail(staged.message, summary);
      if (changes.mode === 'auto') return writtenResult(staged.file, rel, null, lines, summary);
      return succeed(deleteResultText(rel, lines), summary);
    },
  };
}
