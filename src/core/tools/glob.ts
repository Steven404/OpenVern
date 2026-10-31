// Glob filter for `search`. Uses gitignore pattern semantics via the `ignore` package, plus `{a,b}` expansion:
//   "*.ts"        any .ts file at any depth     "src/**/*.tsx"  anchored at the project root
//   "**/*.test.*" any test file                 "*.{ts,tsx}"    braces

import ignore from 'ignore';

/** Expands the first `{a,b}` group recursively. Unbalanced braces are left as literal text. */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (c === ',' && depth === 1) commas.push(i);
  }
  if (close === -1) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const bounds = [open, ...commas, close];
  const results: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const alt = pattern.slice((bounds[i] ?? 0) + 1, bounds[i + 1]);
    for (const expanded of expandBraces(head + alt + tail)) results.push(expanded);
  }
  return results;
}

export type GlobMatcher = (relPath: string) => boolean;

/** Returns a matcher for project-relative POSIX paths, or an error message when the glob is unusable. */
export function compileGlob(glob: string): { ok: true; matches: GlobMatcher } | { ok: false; message: string } {
  const trimmed = glob.trim().replace(/^\.\//, '');
  if (trimmed === '') return { ok: false, message: 'glob is empty' };
  if (trimmed.startsWith('!')) return { ok: false, message: 'negated globs ("!...") are not supported' };
  const ig = ignore();
  for (const p of expandBraces(trimmed)) ig.add(p.startsWith('#') ? `\\${p}` : p);
  return { ok: true, matches: (rel) => ig.ignores(rel) };
}
