// `search` tool (plan S3.6): pure-Node text search over the project, no ripgrep.

import { readFile, stat } from 'node:fs/promises';
import { LIMITS } from '@shared/constants';
import { z } from 'zod';
import { redactSecrets } from '../security/redact';
import { compileGlob, type GlobMatcher } from './glob';
import { isDeniedHardlink, resolveInProject, type SandboxOptions } from './sandbox';
import type { Tool } from './types';
import { abortedResult, displayPath, fail, parseArgs, succeed, toParameters } from './util';
import { walk } from './walk';

const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_LINE_CHARS = 300;
/** Files read concurrently. */
const BATCH = 32;

const argsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Text to look for. Matched literally and case-insensitively unless is_regex is true.'),
  is_regex: z
    .boolean()
    .default(false)
    .describe(
      'Treat query as a JavaScript regular expression (case-insensitive, matched per line). Defaults to false.',
    ),
  path: z
    .string()
    .default('.')
    .describe('Directory (or single file) to search in, relative to the project root. Defaults to the whole project.'),
  glob: z
    .string()
    .optional()
    .describe(
      'Only search files matching this glob, e.g. "*.ts", "src/**/*.tsx" or "*.{js,jsx}". Patterns without "/" match file names at any depth.',
    ),
});

type Matcher = (line: string) => boolean;

function clip(line: string): string {
  const text = line.replace(/\r$/, '').trimEnd();
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}...` : text;
}

/** Returns up to `limit` `rel:line: text` entries for one file; `[]` for skipped (large, binary, unreadable) files. */
async function searchFile(
  abs: string,
  rel: string,
  quickReject: (text: string) => boolean,
  matches: Matcher,
  limit: number,
  signal: AbortSignal,
  secrets: { known?: readonly string[]; deniedFiles?: readonly string[] },
): Promise<string[]> {
  let buf: Buffer;
  try {
    const info = await stat(abs);
    if (!info.isFile() || info.size > LIMITS.searchMaxFileBytes) return [];
    if (await isDeniedHardlink(info, secrets.deniedFiles)) return [];
    buf = await readFile(abs, { signal });
  } catch {
    return [];
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return [];
  const raw = buf.toString('utf8');
  if (quickReject(raw)) return [];
  // Match against the redacted text, so a query cannot probe a secret one character at a time (plan K1).
  const text = redactSecrets(raw, { known: secrets.known }).text;

  const found: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && found.length < limit; i++) {
    const line = lines[i] ?? '';
    if (matches(line)) found.push(`${rel}:${i + 1}: ${clip(line)}`);
  }
  return found;
}

export function createSearchTool(opts: SandboxOptions = {}): Tool {
  return {
    spec: {
      name: 'search',
      description:
        'Search the contents of the project\'s files for text and return matching lines as "path:line: text". ' +
        'Use it to find where a function, string, setting or error message is defined or used; then open the file with read_file. ' +
        'To find files by name or explore the layout use list_files instead. ' +
        'Case-insensitive; the query is literal text unless is_regex is true. Restrict with path and/or glob to keep results focused. ' +
        `Returns at most ${LIMITS.searchMaxMatches} matches. Skips binary files, files over ${Math.round(LIMITS.searchMaxFileBytes / 1024 / 1024)} MB, ` +
        "build/dependency folders and .gitignore'd files. Paths are relative to the project root.",
      parameters: toParameters(argsSchema),
    },

    async run(rawArgs, ctx) {
      const parsed = parseArgs(argsSchema, rawArgs);
      if (!parsed.ok) return fail(parsed.message, 'invalid arguments');
      const { query, is_regex: isRegex, path: relPath, glob } = parsed.data;
      const summary = `"${query.length > 60 ? `${query.slice(0, 57)}...` : query}" in ${displayPath(relPath)}`;

      let matches: Matcher;
      let quickReject: (text: string) => boolean;
      if (isRegex) {
        let re: RegExp;
        let whole: RegExp;
        try {
          re = new RegExp(query, 'i');
          whole = new RegExp(query, 'im');
        } catch (e) {
          return fail(
            `Invalid regular expression: ${(e as Error).message}. Escape special characters or set is_regex to false.`,
            summary,
          );
        }
        matches = (line) => re.test(line);
        quickReject = (text) => !whole.test(text);
      } else {
        const needle = query.toLowerCase();
        matches = (line) => line.toLowerCase().includes(needle);
        quickReject = (text) => !text.toLowerCase().includes(needle);
      }

      let globMatcher: GlobMatcher | null = null;
      if (glob !== undefined) {
        const compiled = compileGlob(glob);
        if (!compiled.ok) return fail(`Invalid glob "${glob}": ${compiled.message}.`, summary);
        globMatcher = compiled.matches;
      }

      const res = await resolveInProject(ctx.projectRoot, relPath, opts);
      if (!res.ok) return fail(res.message, summary);
      if (!res.exists) return fail(`Path not found: ${relPath}. Use list_files to see what exists.`, summary);

      let isDir: boolean;
      try {
        isDir = (await stat(res.abs)).isDirectory();
      } catch {
        return fail(`Cannot read: ${relPath}`, summary);
      }

      const cap = LIMITS.searchMaxMatches;
      const results: string[] = [];
      let truncated = false;
      let filesSearched = 0;

      const passesGlob = (rel: string): boolean => {
        if (!globMatcher) return true;
        if (globMatcher(rel)) return true;
        // Also accept globs written relative to the searched directory.
        const prefix = res.rel === '' ? '' : `${res.rel}/`;
        return prefix !== '' && rel.startsWith(prefix) && globMatcher(rel.slice(prefix.length));
      };

      const processBatch = async (batch: { rel: string; abs: string }[]): Promise<void> => {
        const perFile = await Promise.all(
          batch.map((f) =>
            searchFile(f.abs, f.rel, quickReject, matches, cap + 1, ctx.signal, {
              known: ctx.knownSecrets,
              deniedFiles: opts.deniedFiles,
            }),
          ),
        );
        filesSearched += batch.length;
        for (const found of perFile) {
          for (const line of found) {
            if (results.length >= cap) {
              truncated = true;
              return;
            }
            results.push(line);
          }
        }
      };

      if (!isDir) {
        if (passesGlob(res.rel)) await processBatch([{ rel: res.rel, abs: res.abs }]);
      } else {
        let batch: { rel: string; abs: string }[] = [];
        for await (const entry of walk({
          root: res.root,
          startRel: res.rel,
          maxDepth: Infinity,
          signal: ctx.signal,
          deniedRoots: opts.deniedRoots,
        })) {
          if (entry.kind !== 'file' || !passesGlob(entry.rel)) continue;
          batch.push({ rel: entry.rel, abs: `${res.root}/${entry.rel}` });
          if (batch.length >= BATCH) {
            await processBatch(batch);
            batch = [];
            if (truncated || ctx.signal.aborted) break;
          }
        }
        if (!truncated && !ctx.signal.aborted && batch.length > 0) await processBatch(batch);
      }
      if (ctx.signal.aborted) return abortedResult(summary);

      if (results.length === 0) {
        const scope = globMatcher ? ` (glob "${glob}")` : '';
        return succeed(
          `No matches for "${query}" in ${displayPath(res.rel)}${scope}. ${filesSearched} files searched.`,
          summary,
        );
      }
      const out = [...results];
      if (truncated) {
        out.push(`... truncated at ${cap} matches. Narrow the query, path or glob to see the rest.`);
      }
      return succeed(out.join('\n'), summary);
    },
  };
}
