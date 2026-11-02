// Edit tools (plan G2.1/G2.2, §4.6): `edit_file`, `write_file`, `delete_file`. They never touch the disk; they stage
// content in the chat's change set through `ctx.changes`, which the user later reviews and applies.

import { readFile, stat } from 'node:fs/promises';
import { LIMITS } from '@shared/constants';
import type { FileChange } from '@shared/types';
import { z } from 'zod';
import {
  createResultText,
  deleteResultText,
  editResultText,
  editToolDescriptions,
  noChangeText,
} from '../agent/edit-mode';
import { CoreError } from '../errors';
import { redactSecrets } from '../security/redact';
import { type ResolveResult, resolveForWrite, type SandboxOptions } from './sandbox';
import type { Tool, ToolChanges, ToolContext, ToolResult } from './types';
import { abortedResult, displayPath, fail, parseArgs, succeed, toParameters } from './util';

/** Hard ceiling on files we are willing to load into memory to edit. */
const MAX_EDIT_SOURCE_BYTES = 5 * 1024 * 1024;
const PLACEHOLDER = '«redacted:';
const MAX_MATCH_LINES_LISTED = 10;

const NO_CHANGES_MESSAGE =
  'Editing is not available in this chat: no change set is attached, so nothing can be proposed.';

type Current =
  | { state: 'text'; content: string }
  | { state: 'missing' }
  /** Staged for deletion; still on disk. */
  | { state: 'deleted' }
  | { state: 'binary' }
  | { state: 'other'; message: string };

/** The file as the model sees it: staged content first, then the disk. */
async function loadCurrent(
  rel: string,
  abs: string,
  exists: boolean,
  changes: ToolChanges,
  signal: AbortSignal,
): Promise<Current> {
  const staged = await changes.read(rel);
  if (staged?.kind === 'staged') return { state: 'text', content: staged.content };
  if (staged?.kind === 'deleted') return { state: 'deleted' };
  if (!exists) return { state: 'missing' };
  try {
    const info = await stat(abs);
    if (info.isDirectory()) return { state: 'other', message: `${rel} is a directory, not a file.` };
    if (!info.isFile()) return { state: 'other', message: `${rel} is not a regular file.` };
    if (info.size > MAX_EDIT_SOURCE_BYTES) {
      return { state: 'other', message: `${rel} is too large to edit (${Math.round(info.size / 1024 / 1024)} MB).` };
    }
    const buf = await readFile(abs, { signal });
    if (buf.includes(0)) return { state: 'binary' };
    try {
      return { state: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
    } catch {
      return { state: 'binary' };
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

async function stageContent(
  changes: ToolChanges,
  rel: string,
  content: string | null,
): Promise<{ ok: true; file: FileChange | null } | { ok: false; message: string }> {
  try {
    const { file } = await changes.stage(rel, content);
    return { ok: true, file };
  } catch (e) {
    if (e instanceof CoreError) return { ok: false, message: e.message };
    return { ok: false, message: `Could not propose the change to ${rel}.` };
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
  if (!ctx.changes) return { ok: false, result: fail(NO_CHANGES_MESSAGE, summary) };
  if (ctx.signal.aborted) return { ok: false, result: abortedResult(summary) };
  const res = await resolveForWrite(ctx.projectRoot, relPath, opts);
  if (!res.ok) return { ok: false, result: fail(res.message, summary) };
  if (res.rel === '') return { ok: false, result: fail('The project root is a directory, not a file.', summary) };
  return { ok: true, data: parsed.data, changes: ctx.changes, res, summary };
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

export function createEditFileTool(opts: SandboxOptions = {}): Tool {
  return {
    spec: { name: 'edit_file', description: editToolDescriptions().edit, parameters: toParameters(editSchema) },

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
        return fail(`${rel} is proposed for deletion. To bring it back use write_file with its full content.`, summary);
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
      if (size > LIMITS.writeFileMaxBytes) {
        return fail(
          `The edited file would be ${Math.round(size / 1024)} KB, over the ${Math.round(LIMITS.writeFileMaxBytes / 1024)} KB limit for a proposal.`,
          summary,
        );
      }

      const staged = await stageContent(changes, rel, next);
      if (!staged.ok) return fail(staged.message, summary);
      if (!staged.file) {
        return succeed(
          `Proposed edit to ${rel} brings it back to its content on disk, so no change is proposed for it.`,
          summary,
        );
      }
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

export function createWriteFileTool(opts: SandboxOptions = {}): Tool {
  return {
    spec: { name: 'write_file', description: editToolDescriptions().write, parameters: toParameters(writeSchema) },

    async run(rawArgs, ctx) {
      const prep = await prepare(writeSchema, rawArgs, ctx, opts, (d) => d.path);
      if (!prep.ok) return prep.result;
      const { data, changes, res, summary } = prep;
      const { content } = data;
      const rel = res.rel;

      const bad = checkNewContent(content, 'content');
      if (bad) return fail(bad, summary);
      const size = Buffer.byteLength(content);
      if (size > LIMITS.writeFileMaxBytes) {
        return fail(
          `content is ${Math.round(size / 1024)} KB, over the ${Math.round(LIMITS.writeFileMaxBytes / 1024)} KB limit for a proposal. Split it into several files, or make targeted changes with edit_file.`,
          summary,
        );
      }

      const cur = await loadCurrent(rel, res.abs, res.exists, changes, ctx.signal);
      if (ctx.signal.aborted) return abortedResult(summary);
      const blocked = blockedByState(cur, rel, summary);
      if (blocked) return blocked;
      if (cur.state === 'text' && cur.content === content) return succeed(noChangeText(rel), summary);

      const staged = await stageContent(changes, rel, content);
      if (!staged.ok) return fail(staged.message, summary);
      if (!staged.file) {
        return succeed(
          `Proposed content for ${rel} equals its content on disk, so no change is proposed for it.`,
          summary,
        );
      }
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

export function createDeleteFileTool(opts: SandboxOptions = {}): Tool {
  return {
    spec: { name: 'delete_file', description: editToolDescriptions().delete, parameters: toParameters(deleteSchema) },

    async run(rawArgs, ctx) {
      const prep = await prepare(deleteSchema, rawArgs, ctx, opts, (d) => d.path);
      if (!prep.ok) return prep.result;
      const { changes, res, summary } = prep;
      const rel = res.rel;

      const cur = await loadCurrent(rel, res.abs, res.exists, changes, ctx.signal);
      if (ctx.signal.aborted) return abortedResult(summary);
      if (cur.state === 'missing') return fail(`File not found: ${rel}. Nothing to delete.`, summary);
      if (cur.state === 'deleted') return succeed(`${rel} is already proposed for deletion.`, summary);
      if (cur.state === 'other') return fail(cur.message, summary);

      const staged = await stageContent(changes, rel, null);
      if (!staged.ok) return fail(staged.message, summary);
      return succeed(deleteResultText(rel, cur.state === 'text' ? lineCount(cur.content) : null), summary);
    },
  };
}
