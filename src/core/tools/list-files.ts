// `list_files` tool (plan S3.4).

import { stat } from 'node:fs/promises';
import { LIMITS } from '@shared/constants';
import { z } from 'zod';
import { resolveInProject, type SandboxOptions } from './sandbox';
import { buildTree, truncationNote } from './tree';
import type { Tool } from './types';
import { abortedResult, displayPath, fail, parseArgs, succeed, toParameters } from './util';

const MAX_DEPTH = 5;

const argsSchema = z.object({
  path: z
    .string()
    .default('.')
    .describe(
      'Directory to list, relative to the project root. Defaults to the project root ("."). No absolute paths.',
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPTH)
    .default(2)
    .describe(`How many directory levels to show (1-${MAX_DEPTH}). Defaults to 2.`),
});

export function createListFilesTool(opts: SandboxOptions = {}): Tool {
  return {
    spec: {
      name: 'list_files',
      description:
        'List the files and directories of the project as an indented tree (directories end with "/"). ' +
        'Use it first to get oriented, or to find where something lives before using read_file. ' +
        'To find text inside files use search instead. ' +
        "Paths are relative to the project root. Build output, dependency folders and .gitignore'd files are left out, " +
        `and the listing is capped at ${LIMITS.listFilesMaxEntries} entries (shallowest first): list a subdirectory to see more.`,
      parameters: toParameters(argsSchema),
    },

    async run(rawArgs, ctx) {
      const parsed = parseArgs(argsSchema, rawArgs);
      if (!parsed.ok) return fail(parsed.message, 'invalid arguments');
      const { path: relPath, depth } = parsed.data;
      const summary = displayPath(relPath);

      const res = await resolveInProject(ctx.projectRoot, relPath, opts);
      if (!res.ok) return fail(res.message, summary);

      // Proposed edits are listed too (plan G2.3): created files appear, deleted files are hidden.
      const staged = ctx.changes ? await ctx.changes.staged() : [];
      const overlay = {
        created: staged.filter((s) => s.kind === 'create').map((s) => s.path),
        deleted: new Set(staged.filter((s) => s.kind === 'delete').map((s) => s.path)),
      };
      const dirPrefix = res.rel === '' ? '' : `${res.rel}/`;
      const proposedInside = overlay.created.some((p) => p.startsWith(dirPrefix));
      if (!res.exists && !proposedInside)
        return fail(`Path not found: ${relPath}. Use list_files on a parent directory to see what exists.`, summary);
      if (res.exists) {
        try {
          if (!(await stat(res.abs)).isDirectory()) {
            return fail(`Not a directory: ${relPath}. Use read_file to read a file.`, summary);
          }
        } catch {
          return fail(`Cannot read: ${relPath}`, summary);
        }
      }

      const tree = await buildTree(res.root, res.rel, {
        depth,
        maxEntries: LIMITS.listFilesMaxEntries,
        signal: ctx.signal,
        deniedRoots: opts.deniedRoots,
        ...(ctx.changes ? { overlay } : {}),
      });
      if (tree.aborted) return abortedResult(summary);

      const header = `${displayPath(res.rel)}/ (depth ${depth})`;
      if (tree.lines.length === 0) return succeed(`${header}\n(empty)`, summary);
      const out = [header, ...tree.lines];
      if (tree.truncated) out.push(truncationNote(tree.shown));
      return succeed(out.join('\n'), summary);
    },
  };
}
