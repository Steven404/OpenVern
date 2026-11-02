// Benchmark for the plan's S3 acceptance (~10k files: list_files depth 2 and a literal search each < 2 s).
// Skipped by default; run with:  OPENVERN_BENCH=1 npx vitest run src/core/tools/bench.test.ts

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProjectTools } from './index';

const enabled = process.env.OPENVERN_BENCH === '1';

describe.skipIf(!enabled)('benchmark: ~10k file project', () => {
  let root: string;
  const ctx = () => ({ projectRoot: root, signal: new AbortController().signal });
  const run = (name: string, args: unknown) => {
    const t = getProjectTools().find((x) => x.spec.name === name);
    if (!t) throw new Error(name);
    return t.run(args, ctx());
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'openvern-bench-'));
    await writeFile(path.join(root, '.gitignore'), '*.log\ntmp/\n');
    const body = Array.from(
      { length: 40 },
      (_, i) => `export const value${i} = ${i}; // some filler text for line ${i}`,
    ).join('\n');
    // 20 top dirs x 10 sub dirs x 50 files = 10,000 files (+ ignored junk).
    for (let a = 0; a < 20; a++) {
      for (let b = 0; b < 10; b++) {
        const dir = path.join(root, `pkg${a}`, `mod${b}`);
        await mkdir(dir, { recursive: true });
        await Promise.all(
          Array.from({ length: 50 }, (_, f) =>
            writeFile(
              path.join(dir, `file${f}.ts`),
              f === 7 && a === 13 && b === 4 ? `${body}\nconst rareNeedle = true;\n` : body,
            ),
          ),
        );
      }
    }
    await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await Promise.all(
      Array.from({ length: 500 }, (_, i) => writeFile(path.join(root, 'node_modules', 'dep', `f${i}.js`), body)),
    );
  }, 120_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('list_files depth 2 and literal search each finish in under 2 s', async () => {
    const timings: Record<string, number> = {};
    const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      const out = await fn();
      timings[label] = Math.round(performance.now() - t0);
      return out;
    };

    const list = await time('list_files depth 2', () => run('list_files', { depth: 2 }));
    const listDeep = await time('list_files depth 5 (capped at 500 entries)', () => run('list_files', { depth: 5 }));
    const rare = await time('search literal, 1 match in 10k files', () => run('search', { query: 'rareNeedle' }));
    const none = await time('search literal, no match (full scan)', () =>
      run('search', { query: 'does-not-appear-anywhere' }),
    );
    const regex = await time('search regex, 1 match', () =>
      run('search', { query: 'rare[N]eedle\\b', is_regex: true }),
    );
    const globbed = await time('search literal + glob pkg13/**', () =>
      run('search', { query: 'value7', glob: 'pkg13/**/*.ts' }),
    );

    console.log(`\nbenchmark timings (ms) on 10,000 files:\n${JSON.stringify(timings, null, 2)}`);
    expect(list.ok && listDeep.ok && regex.ok && globbed.ok).toBe(true);
    expect(rare.output).toContain('pkg13/mod4/file7.ts');
    expect(none.output).toContain('No matches');
    expect(timings['list_files depth 2']).toBeLessThan(2000);
    expect(timings['search literal, 1 match in 10k files']).toBeLessThan(2000);
    expect(timings['search literal, no match (full scan)']).toBeLessThan(2000);
  }, 60_000);
});
