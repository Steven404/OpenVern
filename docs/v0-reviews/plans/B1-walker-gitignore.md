# B1: Walker `.gitignore` hardening (S3-M1)

Scope: `src/core/tools/walk.ts` only, plus one new test file. `walk(opts: WalkOptions)` and `WalkOptions` must not change (B2 / S1-M1 option B edits them next).

## 1. Failing tests first: new file `src/core/tools/walk.test.ts`

Use a separate file with its own temp fixture. Don't touch the shared `test-fixture.ts`: a FIFO or `/dev/zero` link there would hang every `tools.test.ts` case. Setup: `base = realpath(mkdtemp(tmpdir()/harness-walk-))`, with `proj/` and `outside/` inside it, and write `outside/evil.gitignore` = `*.txt\n`. Helper `names(startRel)` collects `walk({ root, startRel, maxDepth: Infinity, signal })` into `rel[]`. Each case gets its own subdir under `proj/` so cases don't affect each other. Give every case `{ timeout: 2000 }`, so on current code a hang turns into a failure instead of a stuck run. Skip the FIFO and device cases with `it.skipIf(process.platform === 'win32')`.

`describe('walk .gitignore hardening')`:
1. `ignores a symlinked .gitignore that points outside the root`. Setup: `sym/.gitignore -> outside/evil.gitignore`, plus `sym/a.txt`. Asserts: `sym/a.txt` is listed and `sym/.gitignore` is listed as kind `symlink`. Fails today because l.75 accepts the symlink (`!d.isDirectory()`) and `readFile` follows it, so `*.txt` hides `a.txt`.
2. `does not hang on a FIFO .gitignore`. Setup: `execFileSync('mkfifo', [fifo/.gitignore])` and `fifo/a.txt`. Asserts: the walk finishes and lists `fifo/a.txt`. The FIFO itself is skipped (kind `null`, l.83). Fails today: `readFile` blocks in `open()` until the 2 s timeout. **Teardown:** the blocked open holds a libuv thread and can stop the worker from exiting. In `afterAll`, before `rm`, run `try { closeSync(openSync(fifo, O_WRONLY | O_NONBLOCK)) } catch {}` to release any reader stuck on the FIFO.
3. `does not read a .gitignore symlinked to a device`. Setup: `dev/.gitignore -> /dev/zero`, plus `dev/a.txt`. Asserts: finishes quickly and lists `dev/a.txt`. Fails today: reads until about 2 GB (timeout or OOM).
4. `ignores a symlinked ancestor .gitignore when walking a subdirectory`. Setup: `anc/.gitignore -> outside/evil.gitignore`, `anc/sub/a.txt`, then call `names('anc/sub')`. Asserts: `anc/sub/a.txt` is listed. Fails today because the ancestor loop (l.54-58) reads with no type check.
5. `skips a .gitignore larger than LIMITS.gitignoreMaxBytes`. Setup: a regular `big/.gitignore` = `'*.txt\n' + '#'.repeat(LIMITS.gitignoreMaxBytes)`, plus `big/a.txt`. Asserts: `big/a.txt` is listed. Fails today: there is no cap. Add the same case through an ancestor (`names('big/sub')` with `big/sub/b.txt`).
6. Control: `still honours a regular .gitignore, per-dir and ancestor`. `ok/.gitignore` = `*.txt` hides `ok/a.txt` and `ok/sub/b.txt`, also when starting at `ok/sub`. This passes today and guards against over-fixing.

Also add one `renderTree` case in `tools.test.ts` (`renderTree` describe, l.414) or in the new file: `renderTree(root)` on a project with a FIFO `.gitignore` returns within the timeout. That covers the system-prompt path that has the never-firing signal.

## 2. Fix (`src/core/tools/walk.ts`)

1. `src/shared/constants.ts` LIMITS: add `gitignoreMaxBytes: 256 * 1024`. Why a new constant: `searchMaxFileBytes` (1 MiB) is tuned for scanning text. Every pattern goes into `ignore()` and is checked for every entry under that directory, so 1 MiB of patterns would be costly on each walk. Real `.gitignore` files are well under 10 KB, and 256 KiB still fits generated ones.
2. Rewrite `readGitignore` (l.28-34) so it never follows a link, never blocks and is capped:
   - `const st = await lstat(p)`. Return `null` unless `st.isFile() && st.size <= LIMITS.gitignoreMaxBytes`. This rejects symlinks, FIFOs, sockets, devices and dirs without opening them.
   - `open(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))`, then `fh.stat()` and repeat the same check. This closes the race between lstat and open: a swapped-in symlink fails with ELOOP, and a swapped-in FIFO doesn't block the open. `O_NOFOLLOW` and `O_NONBLOCK` are undefined on Windows, hence the `?? 0`. Windows still has the lstat check.
   - Read at most `gitignoreMaxBytes + 1` bytes with `fh.read` into a buffer. If more than the cap comes back (the file grew), return `null`. Otherwise return `buf.toString('utf8', 0, n)`. Close in `finally`. Keep `catch { return null }` and the early `signal.aborted` check.
   - Oversize means the whole file is skipped, not truncated, because a cut file could end in half a pattern.
3. Per-dir check (l.75): change `!d.isDirectory()` to `d.isFile()`. This is a cheap pre-filter; the helper above remains the real guard.
4. Ancestor loop (l.54-58): no code change needed, since it now goes through the hardened `readGitignore`, which does the `lstat().isFile()` check. Add a one-line comment saying so. Ancestor dirs are safe: `startRel` comes from `resolveInProject` (`sandbox.ts:88`), which is a real path.
5. Update the `walk` doc comment (l.43-47): "`.gitignore` is read only if it is a regular file of at most `gitignoreMaxBytes`; symlinked or special `.gitignore` files are ignored."
6. `renderTree` (`tree.ts:169`): `new AbortController().signal` never fires. Once the fix is in, no `.gitignore` path can block. A hung `readdir` on a stalled network mount still can, but that's outside S3-M1. **Don't change it in B1.** It's optional for a later batch: `AbortSignal.timeout(...)` would need a timeout value, and whether to show a partial tree is a product call (S4 system prompt). Record it as a follow-up note on S3-M1.

## 3. Files, risks, verification

Files: `src/core/tools/walk.ts`, `src/shared/constants.ts` (one new LIMITS key), `src/core/tools/walk.test.ts` (new), and optionally `src/core/tools/tools.test.ts` (renderTree case).

Risks to check:
- A repo that relies on a symlinked `.gitignore` inside the project (rare, for example a shared monorepo file) will no longer have it applied. Those files then show up in `list_files`, `search` and the tree. This is accepted, because only following links that stay inside the root would need a realpath and containment check per directory. Note it in the commit.
- Deny-list and always-skip behaviour is unchanged. Existing `tools.test.ts` cases (nested negation at l.113, ignored dirs at l.82/333) must still pass.
- `bench.test.ts` walk performance: the extra lstat runs only for directories that have a `.gitignore` entry, and on each ancestor. It should be negligible.
- Windows: there's no `mkfifo` and no `O_NOFOLLOW`, so the guarded `?? 0` and the `skipIf` must not break typecheck or CI.
- Mark S3-M1 as fixed in `docs/v0-reviews/s3-code-review-findings.MD` and `INDEX.md` after the tests pass.

Verification: `npx vitest run src/core/tools` (the new cases fail first, then pass), then `npx vitest run`, `npm run typecheck`, `npm run lint`.

## Blocked

Nothing blocks this batch. Two choices were made here, and both can be reversed: oversize means skip the whole file, and the cap is a new 256 KiB constant. The `renderTree` timeout is deferred and needs a product decision.
