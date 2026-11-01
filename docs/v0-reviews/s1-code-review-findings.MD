# S1 code review findings

Reviewed branch `V0` at `ad1cf46`.
Model: Claude Opus 5.5, effort max.

## Summary

S1 meets its acceptance bar. All 5 storage test files pass (63 tests, `vitest run --project node src/core/storage`), every service has tests, and nothing in `src/core` imports Electron (the only matches are in comments). The secrets file itself is handled well: it is 0600 from the moment the tmp file is created, and the key never appears in `PublicSettings` or in error messages. The main risk is the project-root check. A project's folder can contain the data dir, and in dev that lets `read_file` return the plaintext key (major). There are also three minors: relative project paths resolve against the server's working directory, the chat id `index` maps onto the index file, and startup orphan cleanup deletes the bytes behind a quarantined sidecar.

## Findings

### [major] A project folder can contain the data dir, so `read_file` returns the plaintext key

ID: S1-M1

Status: fixed in 6871816 (follow-up open: other instances' data dirs, see INDEX)

- Location: `src/core/storage/projects.ts:64` (`create`), `src/core/storage/index.ts:55` (the data dir is never passed to `createProjectsService`)
- Problem: `create` accepts any readable directory, including one that contains the data dir (or sits inside it). In dev the key is always plaintext at `./.dev-data/secrets.json`, which is inside the harness repo. Trigger: in `npm run dev:web`, add the harness repo as a project and ask "where is my key stored? show me". The README names `secrets.json` and `./.dev-data`, and `read_file .dev-data/secrets.json` returns the whole key. I reproduced this with the current S1 code and S3's `read_file` on a temp dir: `ok: true`, and the output contains the full key. `.gitignore` only hides the file from `list_files` and `search`. In prod, a project at `~` or `~/.config` reaches `.config/harness/secrets.json` (plaintext when the no-keyring fallback store is in use) and every other chat file.
- Why it matters: the key leaves its 0600 file. It lands in a `tool_result` that the renderer shows (breaks §3.3 and A2), in `chats/<id>.json` (written 0644), and in the prompt sent to OpenRouter and the upstream model vendor.
- Direction: `createStorage` already knows `paths.root`. Pass it to `createProjectsService` and reject roots that contain it or sit inside it with `path_invalid`. If adding the harness repo in dev must keep working, export the data dir instead so the tool sandbox can deny it (that consumer is S3/S5).

### [minor] Relative project paths resolve against the server's working directory

ID: S1-N1

Status: fixed in 6871816

- Location: `src/core/storage/projects.ts:27`
- Problem: after `~` expansion, `path.resolve(expanded)` accepts any relative input and resolves it against `process.cwd()`. The body schema (`z.string().trim().min(1)`) doesn't stop it. In dev, typing `.` in the browser path field adds the harness repo, and `src` adds `<repo>/src`. Reproduced: `create({ rootPath: '.' })` succeeds and stores the realpath of the cwd. Only `MockApiClient` rejects this ("Enter an absolute path to a folder."), so `NewProjectModal.test.tsx` passes against behaviour the server doesn't have.
- Why it matters: S6.6 says the field takes absolute or `~` paths. A typo silently gives the model read access to a folder the user didn't choose, and `.` in dev puts you straight into the major finding above.
- Direction: after `~` expansion, reject non-absolute paths with `path_invalid`, and add `.` and `src` cases to `projects.test.ts`.

### [minor] Chat id `index` maps onto `chats/index.json`

ID: S1-N2

Status: open

- Location: `src/core/storage/chats.ts:23` (`SAFE_ID`), `src/core/storage/chats.ts:40` (`chatFile`)
- Problem: `index` passes `SAFE_ID`, so `chatFile('index')` is the index file.
  - `get`, `update`, `appendMessage` and `truncateAfterLastUser` with id `index` read it with the chat schema, fail validation, and quarantine it. So `GET /api/chats/index` renames the index to `index.json.corrupt-<ts>` and logs a false "index.json is corrupt".
  - `remove('index')` deletes the index file and reports success.
  - Two hits in the same millisecond reuse the backup name and overwrite the earlier backup.

  All of this is reproduced. The unsafe-id test (`chats.test.ts:56`) covers `../secrets` and `a/b` but not `index`.
- Why it matters: no chat is lost, because the index is rebuilt from the chat files. But any client can force full rescans and pile up spurious corrupt backups and warnings. This is the only case in S1 where an id maps onto a file that isn't its own.
- Direction: refuse `index` in `chatFile` (or require the UUID shape `randomUUID()` produces), and add `index` to the unsafe-id test.

### [minor] Startup orphan cleanup deletes the bytes behind a quarantined sidecar, even when the attachment is bound

ID: S1-N3

Status: open

- Location: `src/core/storage/attachments.ts:217` (with `listAll` at `src/core/storage/attachments.ts:120`)
- Problem: `cleanupOrphans` first calls `listAll()`, which quarantines a damaged sidecar (`<id>.json` → `<id>.json.corrupt-<ts>`). The stray-`.bin` pass then finds no `<id>.json` and deletes `<id>.bin` once its mtime is more than 24 h old. It cannot check `chatId`, because that is only in the backup. Reproduced: a bound PNG (`chatId: 'chat-1'`) sent two days ago, with a truncated sidecar, loses its bytes in one call, and only the sidecar backup is left. The cleanup test only covers bound attachments with valid sidecars.
- Why it matters: S1.2 backs corrupt files up so they can be recovered, but here the next launch destroys the data the backup describes. That is an attachment from a sent message, not an orphan.
- Direction: in the stray pass, skip ids that have a `<id>.json.corrupt-*` sibling, so only bytes whose sidecar never existed are deleted. Add a bound attachment with a corrupt sidecar to the test.

## Requirement gaps

None.

## Checked and sound

- **`secrets.json` writes:** the tmp file is opened with `wx` and mode 0600, fsynced, then renamed, so neither the tmp file nor the target is ever more permissive than 0600. The mode holds across `set` and `delete` rewrites. Entries use `enc: 'plain'`, and `safeStorage` entries are refused rather than misread. The data dir is created 0700.
- **Key exposure:**
  - `PublicSettings` carries only `configured` and `keyHint`.
  - `keyHint` is `slice(0, 9)` + `…` + `slice(-4)`, giving `sk-or-v1-…a1b2`, with no off-by-one.
  - Errors and warnings name the secret, never its value.
  - Corrupt-file warnings quote V8's `JSON.parse` message. It echoes at most about 10 characters of the file, which in practice is the public `sk-or-v1-` prefix.
- **Locking:** the per-file lock is shared across `JsonFile` instances and reference-counted. A failed callback doesn't poison the chain. The chats lock, the file locks and the projects reads never nest in a cycle. `update` does read-modify-write without lost updates. EACCES and EIO are rethrown, not quarantined.
- **Index rebuild:** it skips `index.json`, `*.tmp`, `*.corrupt-*`, unsafe names, and files whose `id` doesn't match the filename, so it can't duplicate chats. A create after a rebuild updates the existing entry instead of inserting it twice.
- **Projects:**
  - `~` and `~/x` expand correctly.
  - Realpath catches duplicates via symlinks and trailing slashes.
  - The directory and `R_OK|X_OK` checks work, and garbage or NUL input gives `path_invalid`.
  - The duplicate check runs inside the file lock.
  - `remove()` only rewrites `projects.json` and chat files: the project folder is untouched and `updatedAt` is preserved.
- **Attachments:**
  - Sniffing: png/jpeg/gif/webp are detected by magic bytes. The NUL scan of the first 8 KB runs before the size check, followed by a strict UTF-8 decode. Limits are exact at the boundary. SVG is stored as text (`text/plain`), never as an image.
  - Path and name safety: every id goes through `SAFE_ID` before a path is built. Names lose their directory parts.
  - Binding and removal: `bindToChat` validates everything before writing, is idempotent within a chat, and conflicts across chats. `remove` refuses bound attachments.
- **Imports:** no `electron` import anywhere in `src/core`, and storage imports nothing from `src/main` or `src/server`.
