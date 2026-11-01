# B2: Keep the data dir out of project tools (S1-M1 option b) + absolute project paths (S1-N1)

Decision Q1 = (b): folders that contain the data dir stay valid projects, but no tool (`read_file`, `list_files`, `search`, system-prompt `renderTree`) can reach it. This covers already-saved projects. Roots equal to or inside the data dir are rejected with `path_invalid`. Keep B1's `readGitignore` hardening in `walk.ts` unchanged.

**Design.** The denied path is passed in when the tools are built, not per call. `getProjectTools(opts?)` and `renderTree(root, opts)` get an optional `deniedRoots?: readonly string[]` (real absolute paths). `createCore` closes over it, so `GetProjectTools`/`RenderTree` (`tools/types.ts:331-332`), `ToolContext`, `AgentServiceDeps`, `loop.ts` and the agent test helpers all stay as they are. Rejected alternatives: a `ToolContext` field changes the `Tool` contract plus `loop.ts:305`, and it doesn't reach `renderTree` (`loop.ts:175`). The deny is **by real path, never by name**. `.dev-data*` names mean nothing to it (the dev hiding comes from `.gitignore:5`, which tests must not depend on). Message: `kind: 'blocked'` + `BLOCKED_MESSAGE`. `OUTSIDE_MESSAGE` would be false, because the path is inside the project, and the model already treats "blocked" as "don't retry".

## 1. Failing tests first

Fixture: `base = realpath(mkdtemp(tmpdir()/harness-b2-))`, `proj = base/proj` with `README.md`, `data = proj/.dev-data` with `secrets.json` = `{"openrouter":"sk-or-SECRET"}` and `chats/x.json`. **No** `.gitignore`. `ctx = { projectRoot: proj, signal }`, `tools = getProjectTools({ deniedRoots: [data] })`.

`src/core/tools/sandbox.test.ts` (new `describe('deniedRoots')`):
1. `resolveInProject(proj, '.dev-data/secrets.json', { deniedRoots: [data] })` → `{ ok:false, kind:'blocked', message: BLOCKED_MESSAGE }`. Same for `.dev-data`, `./.dev-data/../.dev-data/chats`, and the absolute `${data}/secrets.json`.
2. Symlink: `proj/innocent -> data`, `proj/key.json -> data/secrets.json`. `innocent/secrets.json` and `key.json` → blocked. A symlink *to* `proj` *from* outside isn't relevant.
3. Lexical vs real: pass `deniedRoots` spelled through a symlinked parent (`base/alias -> base`, so `alias/proj/.dev-data`). Callers must realpath; test that `createCore` does it (see test 8).
4. Without `deniedRoots` the old behaviour holds (the existing cases stay green).

`src/core/tools/tools.test.ts` or a new `data-dir.test.ts`, which avoids the shared fixture:
5. Reviewer repro: `read_file {path:'.dev-data/secrets.json'}` → `ok:false`, output has no `sk-or-SECRET`. Also `read_file` via `innocent/secrets.json`.
6. `list_files {path:'.', depth:5}` has no `.dev-data` line. `list_files {path:'.dev-data'}` → blocked. `search {query:'sk-or-SECRET'}` → no matches. `search {query:'SECRET', path:'innocent'}` → blocked.
7. `renderTree(proj, { depth: 3, maxEntries: 100, deniedRoots: [data] })` has no `.dev-data`. With the project root inside data (`renderTree(data/chats, …)`), the output is `(empty)`. The symlink `innocent@` may still be listed by name (it is never followed).

`src/server/*.test.ts` (end-to-end through `createCore`):
8. Use the server `createHarness` (`server/test-helpers.ts:39`; `root` contains `data/`). Create the project at `root` (allowed: it *contains* the data dir), script the fake provider to call `read_file {path:'data/secrets.json'}` after setting a key, and assert that the `tool_result` holds `BLOCKED_MESSAGE` and no key. On macOS this also proves the realpath, because `/var` → `/private/var`.

`src/core/storage/projects.test.ts`:
9. `create({ rootPath: dataDir })` and `create({ rootPath: dataDir/chats })` → `path_invalid`, also through a symlink to `dataDir/chats`. `create({ rootPath: path.dirname(dataDir) })` (contains it) **succeeds**.
10. S1-N1: `create({ rootPath: '.' })` and `create({ rootPath: 'src' })` → `path_invalid`, even when cwd has a `src` (use `process.chdir` to a temp dir that has `src/`, and restore it in `finally`). The `~` and `~/code` cases still pass.

## 2. Fix steps

1. `tools/sandbox.ts`: export `isInside` (l.46) or add `isWithinAny(roots, target)`. `resolveInProject(root, relPath, opts: { deniedRoots?: readonly string[] } = {})` (l.59). After the existing checks at l.76 and l.89, return blocked if `isWithinAny(deniedRoots, abs)` (lexical-mapped) or `isWithinAny(deniedRoots, real)`. Also return blocked when `realRoot` itself is within a denied root (covers saved projects inside the data dir).
2. `tools/walk.ts` `WalkOptions` (l.17): add optional `deniedRoots?: readonly string[]`. In `walk` (l.73): if `join(root,startRel)` is within a denied root, return. In the child loop (l.111) skip `kind==='dir'` entries whose `path.join(root, rel)` is within a denied root. This is a real path, because the walker never follows symlinks and `root` is real. Don't touch `readGitignore` or the ancestor loop.
3. `tools/tree.ts`: `TreeOptions` (l.15) + `buildTree` (l.33) forward `deniedRoots` to `walk`. `renderTree(root, opts: { depth; maxEntries; deniedRoots? })` (l.67) forwards it too, and returns `(empty)` when `realRoot` is within a denied root.
4. `read-file.ts:49`, `list-files.ts:48`/`:58`, `search.ts:126`/`:170`: `createXTool(opts: ToolOptions = {})` passes `opts.deniedRoots` to `resolveInProject`, `buildTree` and `walk`.
5. `tools/index.ts:8`: `getProjectTools(opts: { deniedRoots?: readonly string[] } = {})` forwards to the three factories.
6. `core/index.ts:12-27`: after `createStorage`, `const dataReal = await fs.realpath(path.resolve(expandHome(deps.dataDir)))`, then pass `getProjectTools: () => getProjectTools({ deniedRoots: [dataReal] })` and `renderTree: (r, o) => renderTree(r, { ...o, deniedRoots: [dataReal] })`. Reuse `dataReal` for `cacheFile` (l.17).
7. `storage/projects.ts`: `ProjectsServiceOptions` (l.13) gets `dataDir?: string` (real path). `resolveProjectRoot(input, dataDir?)` (l.22): after `expandHome`, `if (!path.isAbsolute(expanded)) throw new CoreError('path_invalid', 'Enter an absolute path to a folder.')` (S1-N1, which matches the mock text at `mock-api-client.ts:121`). After the realpath (l.27), `if (dataDir && isInside(dataDir, real)) throw new CoreError('path_invalid', 'This folder is inside the app data folder and cannot be a project.')`. Use a local `isInside` copy, or import it from `../tools/sandbox`. Storage importing tools is a new layer edge, so the local copy is preferred.
8. `storage/index.ts:55`: `createProjectsService({ filePath, chats, logger, dataDir: await fs.realpath(paths.root) })`. Update the `types.ts:49` doc comment.

## 3. Interfaces / callers changed (all additive, optional)

`resolveInProject` 3rd param, `WalkOptions.deniedRoots`, `TreeOptions.deniedRoots`, `renderTree` opts, `getProjectTools(opts?)`, `createReadFileTool/createListFilesTool/createSearchTool(opts?)`, `ProjectsServiceOptions.dataDir`. Callers edited: the 3 tool files, `tree.ts`, `tools/index.ts`, `core/index.ts`, `storage/index.ts`. Unchanged: `tools/types.ts` (`ToolContext`, `GetProjectTools`, `RenderTree`), `agent/loop.ts`, `agent/test-helpers.ts`, `bench.test.ts`, `walk.test.ts`, `test-fixture.ts`, `main/backend.ts`, `server/dev.ts`. Existing tests compile untouched.

## 4. Risks and verification

- A non-existent path through a symlinked dir (`innocent/nope`) resolves lexically (`exists:false`) and so returns "not found" instead of "blocked". That leaks existence only, never content. Accepted.
- Only *this process's* data dir is denied. See Blocked.
- A saved project inside the data dir keeps working as an empty, blocked project. It isn't migrated or removed.
- `process.chdir` in test 10: restore it in `finally`. Vitest workers are isolated per file.
- Windows: `path.isAbsolute('C:foo')` is false, so it's rejected as intended.

Verify: `npx vitest run`, `npm run typecheck`, `npm run lint`. Optionally do a manual `npm run dev:web`: add the repo as a project and ask for `.dev-data/secrets.json`.

## Blocked

- **Sibling harness data dirs.** A `preview` run (`.dev-data-preview`, `package.json:19`) with the harness repo as a project can still read dev's plaintext `./.dev-data/secrets.json`, and a dev run with project `~` can read `~/.config/harness`. Each process knows only its own data dir. Options: (a) accept it (this plan), (b) also deny-by-name `.dev-data*` in `isDeniedName` (`sandbox.ts:12`), (c) also deny the default prod `userData` path. Recommendation: (b), as a small follow-up, if the user agrees that name-based hiding of `.dev-data*` is acceptable in every project.
