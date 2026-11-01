# B4: Settings key flow (S6-M1, S6-N2, S6-N3)

Files: `src/renderer/features/settings/SettingsModal.tsx`, `SettingsModal.test.tsx`, plus one additive prop on `ConfirmDialog` in `src/renderer/components/ui/Dialog.tsx` (see N3).
Facts checked: `renderApp` (`app/test-utils.tsx:40`) sets no mutation `gcTime`, so jsdom uses the 300 000 ms default and the bug reproduces in tests. `ERROR_DEFAULTS` (`shared/errors.ts`) already has `invalid_api_key: "OpenRouter rejected this key."` and `network_error: "Couldn't reach OpenRouter. Check your connection."`, and the server/mock/fake all use that copy. So both overrides in `keyErrorMessage` (l.16-17) are redundant, and l.17 hides `http-api-client.ts:18` `SERVER_UNREACHABLE` ("Couldn't reach the harness server.").

## 1. Failing tests first (`SettingsModal.test.tsx`)

Constant: `const KEY = 'sk-or-v1-0123456789abcdefWXYZ'`. Helper: `const dump = (qc) => JSON.stringify(qc.getMutationCache().getAll().map((m) => m.state))`.

1. **`'save: the key never stays in the mutation cache (success)'`**: `openSettings({ keyConfigured: false })`, type `KEY`, click Save, `await findByText(/Connected/)`. Assert `queryClient.getMutationCache().getAll().every((m) => m.state.variables === undefined)` and `expect(dump(queryClient)).not.toContain(KEY)`. **Fails today**: `state.variables === KEY` (l.150/164) and the mutation stays cached for 5 min after `KeyForm` unmounts.
2. **`'save: the key never stays in the mutation cache (failure, then edit)'`**: spy `setOpenRouterKey` → `mockRejectedValue(new ApiError(errorInfo('network_error')))`. Type `KEY`, click Save, wait for the alert. Assert the same two things while the form is still mounted. Then change the input to `KEY + 'x'` (calls `save.reset()`), Save again, and assert again: no cached mutation, old or new, has either string. Also assert the field's error text does not contain `KEY`. **Fails today**: there is one cached copy per attempt.
3. **N2, rewrite the toggle part of the first test (l.32-35)**: `const toggle = getByRole('button', { name: 'Show key' })`, then `aria-pressed` is `'false'`. Click it: `input.type === 'text'`, the same element has `aria-pressed='true'`, it is still named "Show key", and `queryByRole('button', { name: 'Hide key' })` is null. Click again: password, `'false'`. **Fails today**: the label flips to "Hide key" (l.199).
4. **N3 save, `'save: shows the client\'s own network message (harness server down)'`**: reject with `new ApiError(errorInfo('network_error', "Couldn't reach the harness server."))`. Expect that text, and `queryByText(/Couldn't reach OpenRouter/)` null. **Fails today**: l.17 overrides it. Keep the existing l.51-57 test, renamed `'... server network_error copy'`. It still passes because it uses the default message.
5. **N3 remove, `'Remove failure shows the error inside the confirm and keeps it open'`**: `openSettings()`, spy `removeOpenRouterKey` → reject with the harness-server `network_error`. Click Remove key, then confirm. `within(confirm).findByRole('alert')` has text "Couldn't reach the harness server."; the confirm is still in the document; `within(dialog).queryByRole('alert')` is null (the confirm is portalled, so `dialog` does not contain it). Click Cancel, reopen Remove key: no alert (stale error cleared). **Fails today**: the alert is rendered in the Settings body at l.123-127, behind the overlay, with the OpenRouter copy.

## 2. Fix steps (`SettingsModal.tsx`)

**S6-M1 (l.143-165).** Do both: keep the key out of `variables` (primary) and set `gcTime: 0` (defence in depth).
- `const keyRef = useRef('')`. `mutationFn: () => { const key = keyRef.current; keyRef.current = ''; return api.setOpenRouterKey(key); }`, and add `gcTime: 0`.
- `submit`: `keyRef.current = key; save.mutate();` (no args).
- Why both: with `mutate()` and no args, `state.variables` is `undefined`, so nothing in the cache state holds the key even while the failed mutation is still observed, and no devtools or `useMutationState` can see it. Clearing the ref on read matters because `mutation.options.mutationFn` closes over `keyRef`. Without the clear, a cached mutation would keep the key reachable through the ref. A state closure (`apiKey`) would leak the same way, which is why we use a ref and not `mutationFn: () => api.setOpenRouterKey(apiKey.trim())`. `gcTime: 0` drops each mutation (result and error included) as soon as its observer goes. `gcTime: 0` alone is not enough: a failed mutation stays observed while the form is mounted, with the key in `variables`.
- Mutations don't retry (the default is 0 and `App.tsx:17` doesn't override it), so clear-on-read can't send an empty key on a retry. Leave a one-line comment saying so.

**S6-N2 (l.199).** `aria-label="Show key"` (fixed). Keep `aria-pressed={visible}` and the icon swap.

**S6-N3.**
- l.14-21: `return error instanceof ApiError ? error.info.message : 'Something went wrong. Try again.'`. Update the doc comment to say it covers save and remove. Keep the export (`features/settings/index.ts`; no other consumers).
- `Dialog.tsx` `ConfirmDialog`: add an optional `children?: ReactNode` to `ConfirmDialogProps` and pass it through as `DialogContent` children. This is additive and does not touch `onCloseAutoFocus`, which P10/S6-N1 edits.
- l.118: `onClick={() => { remove.reset(); setConfirmOpen(true); }}`. l.130: `onOpenChange={(o) => { if (!o) remove.reset(); setConfirmOpen(o); }}`.
- Move the l.123-127 `<p role="alert">{keyErrorMessage(remove.error)}</p>` into `<ConfirmDialog>` as its children, and delete it from the body.
- Error text is only ever `info.message` or fixed copy. Neither the input nor the key is interpolated anywhere, and test 2 guards this.

## 3. Risks
- `ConfirmDialog` is shared. The new prop is optional and other callers are unchanged. Run the full suite.
- Removing the l.16 override relies on the server message. A malformed key can currently surface a raw fetch error that contains the key (S2-N1, server side). The renderer can't fix that. S2-N1 needs to land too, or before this.
- Test 1 timing: `onSuccess` calls `onDone()`, which unmounts the observer. The `gcTime: 0` removal runs on a 0 ms timer, but the `variables`/dump assertions hold whether or not the mutation is still listed.

## 4. Verification
`npx vitest run src/renderer/features/settings` (tests 1-5 red before the fix, green after), then `npx vitest run`, `npm run typecheck` and `npm run lint`.

## Blocked
None. All defaults were accepted in INDEX "Decisions (2026-11-02)": a fixed "Show key" label with `aria-pressed`, and a failed Remove shown inside the confirm.
