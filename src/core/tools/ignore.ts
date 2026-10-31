// Ignore rules (plan S3.3): always-skipped directories plus `.gitignore` files at every depth.

import ignore, { type Ignore } from 'ignore';

export const ALWAYS_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'target',
  '.venv',
  'venv',
  '__pycache__',
]);

interface Frame {
  /** Directory the `.gitignore` lives in, relative to the project root (`''` for the root). */
  base: string;
  ig: Ignore;
}

/** The stack of `.gitignore` files that apply to a directory. Immutable; `with` returns a deeper scope. */
export class IgnoreScope {
  private constructor(private readonly frames: readonly Frame[]) {}

  static readonly empty = new IgnoreScope([]);

  /** Adds the `.gitignore` found in directory `base` (project-relative, POSIX). */
  with(base: string, gitignoreContent: string): IgnoreScope {
    return new IgnoreScope([...this.frames, { base, ig: ignore().add(gitignoreContent) }]);
  }

  /** Whether the project-relative POSIX path is ignored. Deeper `.gitignore` files win over shallower ones. */
  ignores(rel: string, isDir: boolean): boolean {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i];
      if (!frame) continue;
      const sub = frame.base === '' ? rel : rel.slice(frame.base.length + 1);
      if (sub === '') continue;
      const res = frame.ig.test(isDir ? `${sub}/` : sub);
      if (res.ignored) return true;
      if (res.unignored) return false;
    }
    return false;
  }
}
