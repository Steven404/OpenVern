// `read_file` tool (plan S3.5).

import { readFile, stat } from 'node:fs/promises';
import { LIMITS } from '@shared/constants';
import { z } from 'zod';
import { PROPOSED_DELETED_NOTE, PROPOSED_VERSION_NOTE } from '../agent/edit-mode';
import { redactionNote, redactSecrets } from '../security/redact';
import { resolveInProject, type SandboxOptions } from './sandbox';
import type { Tool } from './types';
import { abortedResult, displayPath, fail, parseArgs, succeed, toParameters } from './util';

const BINARY_SNIFF_BYTES = 8 * 1024;
/** Hard ceiling on files we are willing to load into memory to count lines. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const argsSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('File to read, relative to the project root (e.g. "src/index.ts"). No absolute paths.'),
  start_line: z.number().int().min(1).optional().describe('First line to return (1-based). Defaults to 1.'),
  end_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Last line to return (1-based, inclusive). At most ${LIMITS.readFileMaxLines} lines are returned per call.`,
    ),
});

/** Longest prefix of `text` that fits in `maxBytes` of UTF-8, never splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

export function createReadFileTool(opts: SandboxOptions = {}): Tool {
  return {
    spec: {
      name: 'read_file',
      description:
        'Read a text file from the project. Lines are returned prefixed with their line numbers (the numbers are not part of the file). ' +
        'Use it after list_files or search has told you which file matters; read the relevant file before making claims about its contents. ' +
        `Large files are cut at ${LIMITS.readFileMaxLines} lines or ${Math.round(LIMITS.readFileMaxBytes / 1024)} KB per call: ` +
        'pass start_line / end_line to read further ranges. Binary files and secret files (.env, keys) cannot be read. ' +
        'The path is relative to the project root.',
      parameters: toParameters(argsSchema),
    },

    async run(rawArgs, ctx) {
      const parsed = parseArgs(argsSchema, rawArgs);
      if (!parsed.ok) return fail(parsed.message, 'invalid arguments');
      const { path: relPath, start_line: startArg, end_line: endArg } = parsed.data;
      const summary = relPath;

      const res = await resolveInProject(ctx.projectRoot, relPath, opts);
      if (!res.ok) return fail(res.message, summary);

      // Proposed edits are read through (plan G2.3): staged content replaces the disk, staged deletions hide the file.
      const staged = ctx.changes ? await ctx.changes.read(res.rel) : null;
      if (staged?.kind === 'deleted') {
        return fail(`File not found: ${relPath} (${PROPOSED_DELETED_NOTE}).`, summary);
      }
      if (!res.exists && !staged)
        return fail(`File not found: ${relPath}. Use list_files or search to find the right path.`, summary);

      const start = startArg ?? 1;
      if (endArg !== undefined && endArg < start) {
        return fail(`end_line (${endArg}) is before start_line (${start}).`, summary);
      }

      let source: string;
      if (staged?.kind === 'staged') {
        source = staged.content;
      } else {
        let buf: Buffer;
        try {
          const info = await stat(res.abs);
          if (info.isDirectory())
            return fail(`${relPath} is a directory. Use list_files to see its contents.`, summary);
          if (!info.isFile()) return fail(`${relPath} is not a regular file.`, summary);
          if (info.size > MAX_FILE_BYTES) {
            return fail(
              `File too large to read (${Math.round(info.size / 1024 / 1024)} MB). Use search to find specific content.`,
              summary,
            );
          }
          buf = await readFile(res.abs, { signal: ctx.signal });
        } catch (e) {
          if (ctx.signal.aborted) return abortedResult(summary);
          return fail(`Cannot read ${relPath}: ${(e as NodeJS.ErrnoException).code ?? 'unknown error'}`, summary);
        }

        if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
          return fail(`Binary file: ${relPath} cannot be displayed as text.`, summary);
        }
        source = buf.toString('utf8');
      }
      const proposedNote = staged?.kind === 'staged' ? ` ${PROPOSED_VERSION_NOTE}` : '';

      // Redact before slicing: line numbers stay valid (replacements keep line breaks) and no limit can cut a key in two.
      const redacted = redactSecrets(source, { known: ctx.knownSecrets });
      const lines = redacted.text.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const total = lines.length;
      if (total === 0) return succeed(`${displayPath(res.rel)} (empty file, 0 lines)${proposedNote}`, summary);
      if (start > total) {
        return fail(`start_line ${start} is past the end of the file (${total} lines).`, summary);
      }

      const lastRequested = Math.min(endArg ?? Infinity, total);
      const lastByLines = Math.min(lastRequested, start + LIMITS.readFileMaxLines - 1);
      const width = String(lastByLines).length;
      const body: string[] = [];
      let bytes = 0;
      let last = start - 1;
      let cutByBytes = false;
      const headerFor = (lastLine: number) =>
        `${displayPath(res.rel)} (lines ${start}-${lastLine} of ${total})${proposedNote}`;
      const byteCutNote = (lastLine: number) =>
        `... output cut at ${Math.round(LIMITS.readFileMaxBytes / 1024)} KB. Continue with start_line=${lastLine + 1}.`;
      for (let n = start; n <= lastByLines; n++) {
        const text = (lines[n - 1] ?? '').replace(/\r$/, '');
        const line = `${String(n).padStart(width)} | ${text}`;
        const size = Buffer.byteLength(line) + 1;
        if (bytes + size > LIMITS.readFileMaxBytes) {
          cutByBytes = true;
          if (body.length === 0) {
            // A single enormous line (e.g. minified code): return its beginning rather than nothing.
            // Cut by UTF-8 bytes, leaving room for the header, marker and trailer so the whole output fits.
            const marker = ' [line cut]';
            const overhead =
              Buffer.byteLength(headerFor(n)) + Buffer.byteLength(marker) + Buffer.byteLength(byteCutNote(n)) + 3;
            body.push(`${truncateUtf8(line, LIMITS.readFileMaxBytes - overhead)}${marker}`);
            last = n;
          }
          break;
        }
        body.push(line);
        bytes += size;
        last = n;
      }

      const header = headerFor(last);
      const out = [header, ...body];
      if (cutByBytes) {
        out.push(byteCutNote(last));
      } else if (last < lastRequested) {
        out.push(`... output cut at ${LIMITS.readFileMaxLines} lines. Continue with start_line=${last + 1}.`);
      } else if (last < total) {
        out.push(`... ${total - last} more line(s) in the file. Continue with start_line=${last + 1}.`);
      }
      if (redacted.count > 0) out.push(redactionNote(redacted.count));
      const range = start === 1 && last === total ? '' : ` (lines ${start}-${last})`;
      return succeed(out.join('\n'), `${relPath}${range}`);
    },
  };
}
