# S3 code review findings

Reviewed branch `V0` at `ad1cf46`.
Model: Claude Opus 5.5, effort high.

## Summary

The path sandbox and the deny list are correct. I found no way for `list_files`, `read_file` or `search` to return the contents of a file outside the project root or of a secret-looking file. The one real hole is in the shared walker. It reads every `.gitignore` it finds with a plain `readFile`, which follows symlinks and opens FIFOs and devices. So an untrusted repo can make the walker read outside the root. It can also hang `renderTree`, which cannot be aborted, or exhaust memory there. One cap is also measured wrongly: `readFileMaxBytes` counts characters, not bytes, when a single line is cut. With those two fixed, S3 meets its acceptance bar. I could not run the test suite: `ignore` is listed in `package.json` and the lockfile but is missing from the local `node_modules` (a stale install, not an S3 defect).

## Findings

### [major] Walker reads `.gitignore` through symlinks, FIFOs and devices, even outside the root

ID: S3-M1

Status: fixed in 60b877d

- Location: `src/core/tools/walk.ts:28` (`readGitignore`), `src/core/tools/walk.ts:56` (ancestor loop), `src/core/tools/walk.ts:75`
- Problem: Line 75 accepts any `.gitignore` entry that is not a directory, which includes symlinks, FIFOs and sockets. The ancestor loop at line 56 does no type check at all. `readFile` then follows the link with no size limit. Git stores symlinks, so a cloned repo can ship `sub/.gitignore -> /dev/zero`, `-> /dev/stdin`, or a link to any file on the machine.
  - I confirmed with Node that `readFile` on a FIFO blocks forever. Aborting the passed `signal` does not release it.
  - For `/dev/zero`, `readFile` keeps allocating until Node's ~2 GB read limit.
- Why it matters:
  - This is the only path in S3 that opens a file outside the project root. The contents become ignore patterns and are not echoed back, so it is not a disclosure, but it breaks the "cannot read outside the root" property.
  - The concrete harm is denial of service. `renderTree` (`tree.ts:70`) passes `new AbortController().signal`, which can never fire. If the system prompt is built from it on each turn (S4), a project with such a `.gitignore` hangs or out-of-memories the server.
  - `list_files` and `search` also hang, and the hang occupies a libuv thread-pool thread.
  - No test covers a non-regular `.gitignore`.
- Direction: Only read `.gitignore` when it is a regular file. In the per-directory case, use `d.isFile()` instead of `!d.isDirectory()`. In the ancestor loop, check with `lstat(...).isFile()`. Cap the read size (for example `searchMaxFileBytes`). Add a fixture with a symlinked `.gitignore` pointing outside the root.

### [minor] Single-line cut ignores `readFileMaxBytes` for multibyte text

ID: S3-N1

Status: fixed in b80607f

- Location: `src/core/tools/read-file.ts:103`
- Problem: When the first line alone is over the byte budget, it is cut with `line.slice(0, LIMITS.readFileMaxBytes)`. That counts UTF-16 code units, not bytes. A minified line of CJK text (3 bytes per character) therefore returns about 300 KB. Emoji or other astral characters (4 bytes per character, 2 code units) return about 200 KB. The cut can also split a surrogate pair. The test at `tools.test.ts:230` only uses ASCII, so it passes.
- Why it matters: The output is 2–3× over the cap S3.5 requires and goes straight into model context. No security impact.
- Direction: Truncate by bytes, for example `Buffer.from(line).subarray(0, max).toString('utf8')` minus the prefix and marker length. Add a non-ASCII case to the test.

## Requirement gaps

- S3.1 / S3.10: the symlink-escape guarantee does not cover the walker's own `.gitignore` reads, and the tests do not exercise that case (see the major finding).
- S3.5: `readFileMaxBytes` is not enforced as bytes on the single-long-line path (see the minor finding).

## Checked and sound

- **Containment check** (`isInside` in `sandbox.ts`): uses `path.relative` and correctly rejects the `/proj` vs `/proj-evil` prefix trick, `..`, and `../x`. Names like `..foo` are correctly treated as inside.
- **Lexical normalization:** paths are normalized before `realpath`, so `link/../x` cannot follow the symlink's parent. The kernel only ever sees the normalized path.
- **Symlinked project root:** the lexical-root to real-root mapping is correct for absolute paths spelled through either root. It is untested, because the fixture calls `realpath` on its base.
- **Deny list, two passes:** it runs on both the lexical and the real relative path, every segment, lowercased. A symlink to `.env`, a symlinked directory into `.git`, and secrets inside a symlinked directory are all blocked. Paths that don't exist are still checked for containment and deny rules.
- **Deny-list contents:** `.env.example` and `.env.sample` are the only `.env.*` exceptions, and variants like `.env.example.local` stay blocked. `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `id_ed25519*`, and a `.git` file or directory at any depth are all denied.
- **Walker:** symlinks are listed (suffixed `@`) but never followed, and `search` only reads entries of kind `file`. Denied names and always-skipped directories are pruned before descending.
- **Nested `.gitignore`:** frames are applied deepest-first with negation, and the ancestors' ignore files are applied when listing or searching a subdirectory.
- **`read_file` checks:** a regular-file check runs before reading (so FIFOs and devices are rejected), there is a 20 MB hard ceiling, NUL detection in the first 8 KB, and correct line-range errors and header.
- **`search`:** skips files over `searchMaxFileBytes` and binaries. It caps at `searchMaxMatches` and flags truncation only when more matches actually exist. A single-file path goes through the sandbox, and an invalid regex or glob returns `ok:false`.
- **List limits:** `list_files` and `renderTree` enforce `listFilesMaxEntries` / `maxEntries` breadth-first (shallowest first), and depth is limited to 1–5 by zod.
- **Argument handling and abort:** every tool validates arguments with zod `safeParse`, so bad arguments return `ok:false` instead of throwing. `ctx.signal` is checked for each directory and each batch, and passed to `readFile`.
- **`renderTree`:** catches all errors and never throws.
