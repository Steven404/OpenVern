# S6 code review findings

Reviewed branch `V0` at `ad1cf46`.
Model: Claude Opus 5.5, effort max.

## Summary

S6 meets its behavioral acceptance bar: every D1–D9 and D19 action works against the mock as specified. The 57 tests in the six in-scope test files pass, and the renderer typechecks clean. The API key flow is mostly correct: masked input, fixed or server-supplied error copy, only `PublicSettings` cached, nothing in `localStorage` or logs, and the models query invalidated. One real gap breaks the stated invariant. The save mutation leaves the full key in TanStack's mutation cache for about 5 minutes after every attempt. It is a one-line fix and I would hold sign-off on the key flow until it is in. The other three findings are minor.

## Findings

### [major] Save-key mutation keeps the full API key in the TanStack mutation cache for 5 minutes

ID: S6-M1

Status: fixed in dc933ac

- Location: `src/renderer/features/settings/SettingsModal.tsx:149`. Also `:164` (`save.mutate(key)`) and `src/renderer/app/App.tsx:17`, which sets no mutation `gcTime`.
- Problem: The full key is passed as the mutation's `variables`, so TanStack stores it in `mutation.state.variables` inside `queryClient.getMutationCache()`. After `KeyForm` unmounts, the mutation is only garbage-collected after the default `gcTime` of 300 000 ms in a browser or Electron renderer. The form unmounts on a successful save, when the modal closes, or when the user edits after a failure (`save.reset()`). Every new attempt also leaves the previous mutation behind for the same 5 minutes.
  - Trigger: save any key. For the next 5 minutes, `queryClient.getMutationCache().getAll()[0].state.variables` is the full `sk-or-v1-…` string. Each failed or retried attempt adds another copy.
  - I confirmed this against query-core 5.105.0: after the observer unsubscribes, the mutation is still in the cache with the full key in `variables`.
- Why it matters: It breaks the "not stored in the renderer after save / not in the query cache" invariant on the main-risk flow. The exposure is in memory only: nothing is persisted, logged or sent, and it clears after 5 minutes. But anything holding the QueryClient (devtools, a future `useMutationState`) can read it, and no test guards against it.
- Direction: Set `gcTime: 0` on the save mutation, or keep the key out of `variables` by reading it from a ref inside `mutationFn`. Add a test that, after a successful save, no cached mutation has the key in `state.variables`.

### [minor] App-level modals return focus to an element that no longer exists

ID: S6-N1

Status: open

- Location: `src/renderer/stores/ui.ts:50` (`rememberFocus`) together with `src/renderer/components/ui/Dialog.tsx:38-43`.
- Problem: `openSettings` and `openNewProject` remember whatever has focus at that moment. On close, `DialogContent` calls `preventDefault()` and then `.focus()` on that element, even if it is no longer in the DOM. Two triggers:
  1. New chat screen → project chip → "Add project…" → Cancel or Esc. The remembered element is the Radix menu item, which unmounted when the menu closed, so focus lands on `<body>` instead of the chip. `ui.ts:63` names this chip as an intended caller.
  2. First run → composer notice "Open settings" → save a key → close Settings. The notice and its button disappear once a key is configured, so focus lands on `<body>`.

  The bug is in S6's mechanism; the S7 callers use the API as documented. The Sidebar openers work, and they are the only ones the tests cover.
- Why it matters: S6.10 requires dialogs to return focus to their trigger. Keyboard and screen-reader users are dropped at the top of the document, including in the A1→A2 first-run flow.
- Direction: In `rememberFocus`, if the focused element is inside `[role="menu"]`, store that menu's trigger instead (the element with matching `aria-controls`). In `onCloseAutoFocus`, only call `preventDefault()` when `target.isConnected`; otherwise focus a stable fallback such as `main` or the composer.

### [minor] Show/hide key toggle announces the opposite state

ID: S6-N2

Status: fixed in dc933ac

- Location: `src/renderer/features/settings/SettingsModal.tsx:199-200`
- Problem: The button uses both a changing label and `aria-pressed`. While the key is visible, a screen reader announces "Hide key, toggle button, pressed", which reads as "hiding is on" when the key is actually shown in plain text.
- Why it matters: Telling the user whether the key is exposed is the toggle's only job in the key flow.
- Direction: Either use a fixed label ("Show key") with `aria-pressed={visible}`, or keep the changing label and drop `aria-pressed`. Update the test, which looks the button up by both names.

### [minor] Key error copy blames OpenRouter for local failures, including Remove key

ID: S6-N3

Status: fixed in dc933ac

- Location: `src/renderer/features/settings/SettingsModal.tsx:17`. The same function handles Remove errors at `:125`.
- Problem: `keyErrorMessage` turns every `network_error` into "Couldn't reach OpenRouter. Check your connection." But `HttpApiClient` also throws `network_error` when the local server is unreachable, with the accurate message "Couldn't reach the harness server." (`http-api-client.ts:45`), and this code overwrites it.
  - Trigger: the dev server is stopped or restarting → Save or Remove key → the user is told to check their internet connection.
  - For Remove the copy is always wrong, because DELETE never contacts OpenRouter.
  - The confirm dialog also stays open on a failed Remove, so the error appears in the Settings body behind its overlay.
- Why it matters: It points the user at the wrong cause in the key flow. It is rare in Electron, where the backend runs in-process.
- Direction: Just show `error.info.message`. The server's standard `network_error` message is already the plan's copy. If you want an explicit check, server errors have `status === 502` and client-side failures have no status. For a failed Remove, close the confirm or show the error inside it.

## Requirement gaps

- S6.10 ("dialogs return focus to their trigger") is only partly met. It fails for app-level modals opened from a menu item or from a button that disappears (see the focus finding above).
- Every other item in S6.1–S6.11 is met.

## Checked and sound

- **Key handling:**
  - `type=password` input with a show/hide toggle, `spellCheck={false}`, and the key trimmed and sent only through `setOpenRouterKey`.
  - `KeyForm` state is dropped on success (the form unmounts once `configured` flips) and whenever the modal closes, since its content is mounted only while open.
  - Only the server's `PublicSettings` goes into `queryKeys.settings`.
  - The key never appears in `console`, `localStorage`, a URL or a query key anywhere in the renderer.
  - Error text is fixed copy or the server's `info.message`, never the input.
  - Mutations do not retry, so the PUT is never resent.
- **Connected state:** shows only "Connected · keyHint". Replace has a Cancel, Remove goes through a confirm, and both Save and Remove update the `settings` cache and invalidate `models`. The `https://openrouter.ai/keys` link uses `target=_blank rel=noreferrer`; in Electron, `setWindowOpenHandler` hands it to `shell.openExternal`.
- **Sidebar D1–D7:**
  - New chat goes to the new-chat route with the current chat's project, and gets `aria-current` on `#/new`.
  - Project rows have `aria-expanded`/`aria-controls` and a rotating chevron.
  - The server `chatCount` stays fresh because move, delete and remove all invalidate `projects`.
  - Expansion is persisted in `harness.expandedProjects` and survives blocked storage; the active chat's project auto-expands.
  - Both chat lists are sorted newest first, and the CHATS section is hidden when empty.
- **Project "…" menu:**
  - New chat here, Rename (select-all dialog), and Remove with the plan's copy, including the 0- and 1-chat wording.
  - Remove collapses the row, leaves `?project=<id>` if it points at the removed project, and invalidates projects, chats and every cached `chat(id)`.
  - Focus returns to the "…" trigger.
- **New project modal:**
  - Electron: read-only path plus Browse…, and cancelling the picker keeps the current value.
  - Browser: text field that accepts `~`.
  - Name is prefilled from the folder basename until the user edits it.
  - `path_invalid` and `conflict` appear inline with `aria-invalid` and clear on edit.
  - Success expands the project, navigates to `#/new?project=<id>` and closes; the form is fresh each time it opens.
- **Chat header D8–D9:**
  - Breadcrumb shows the project name (uppercase via CSS) or "Chats".
  - `document.title` is set and reset by ChatHeader and AppShell.
  - Rename selects the current title and does nothing if it is unchanged.
  - Move uses a radio group with the current project checked, plus "No project".
  - Delete asks for confirmation, then calls `deleteChat`, navigates to `#/new`, drops `chat(id)` from the cache and invalidates the lists.
- **Shell:**
  - Unknown routes redirect to `#/new`.
  - ChatScreen passes the S6↔S7 seam props and uses whichever of the list entry or `chat(id)` is newer, so live titles win.
  - Collapse persists in `harness.sidebarCollapsed`. The ≤760px overlay starts closed, is not persisted, and closes on navigation, breakpoint change, Escape or backdrop click.
  - Focus moves between the Collapse and Open sidebar buttons.
  - Ctrl+N, Ctrl+B and Escape are ignored while any dialog, menu or popover is in the DOM.
- **Primitives:** Radix dialog with focus trap, Esc and backdrop close, plus `returnFocusRef` for menu-opened dialogs. Menu supports submenus and radio/check items. IconButton requires `aria-label` at the type level. TextField wires `aria-invalid`/`aria-describedby`. Button `loading` sets disabled and `aria-busy`.
- **What I ran:**
  - The six in-scope test files pass (57 tests), and `tsc -p tsconfig.web.json` is clean.
  - The full `npm run typecheck` stops in `src/core/tools` because `ignore` is missing from `node_modules` in this checkout. That is a stale install, not S6.
