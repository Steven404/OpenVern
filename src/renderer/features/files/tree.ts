import type { ProjectFileEntry, ProjectFileListing, ProjectFileSearchResult } from '@shared/types';

export interface EntryRow {
  kind: 'entry';
  path: string;
  name: string;
  /** Dimmed `dir/` prefix (filter results only). */
  dir: string;
  isDir: boolean;
  depth: number;
}

/** A quiet line inside the tree: a folder still loading, a folder that failed, or a truncation note. */
export interface StatusRow {
  kind: 'status';
  key: string;
  depth: number;
  text: string;
  /** A failed folder: the folder to load again from the row's "Try again". */
  retry?: string;
}

export type TreeRow = EntryRow | StatusRow;

/**
 * What is known about an expanded folder's children. `error` carries the message to show (the server's, e.g. a macOS
 * privacy denial, or `FOLDER_ERROR`); `gone` is a folder that no longer exists, drawn like an empty one.
 */
export type FolderState =
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | { status: 'gone' }
  | { status: 'success'; listing: ProjectFileListing };

export const FOLDER_LOADING = 'Loading…';
export const FOLDER_ERROR = "Couldn't load this folder.";
export const FOLDER_TRUNCATED = 'This folder is large, so only part of it is listed.';

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** All ancestors of `path` are expanded, so the folder is on screen (if it exists). */
export function ancestorsExpanded(path: string, expanded: Record<string, true>): boolean {
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    if (!expanded[path.slice(0, i)]) return false;
  }
  return true;
}

/** Expanded folders whose ancestors are all expanded, parents before children. */
export function visibleExpandedFolders(expanded: Record<string, true>): string[] {
  return Object.keys(expanded)
    .filter((p) => ancestorsExpanded(p, expanded))
    .sort();
}

/**
 * Rows to draw for the tree: the root's entries, and below each expanded folder its own listing (looked up with
 * `folder`), a "Loading…" row while it loads, or a quiet error row with a retry (nothing for a folder that is gone). A
 * truncated listing ends with a note at its depth.
 */
export function buildRows(
  root: ProjectFileListing,
  folder: (dir: string) => FolderState | undefined,
  expanded: Record<string, true>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const emit = (listing: ProjectFileListing, depth: number) => {
    for (const e of listing.entries) {
      const isDir = e.type === 'dir';
      rows.push({ kind: 'entry', path: e.path, name: baseName(e.path), dir: '', isDir, depth });
      if (!isDir || !expanded[e.path]) continue;
      const state = folder(e.path) ?? { status: 'pending' };
      if (state.status === 'success') emit(state.listing, depth + 1);
      else if (state.status === 'error') {
        rows.push({ kind: 'status', key: `error:${e.path}`, depth: depth + 1, text: state.message, retry: e.path });
      } else if (state.status === 'pending') {
        rows.push({ kind: 'status', key: `pending:${e.path}`, depth: depth + 1, text: FOLDER_LOADING });
      }
    }
    if (listing.truncated) {
      rows.push({ kind: 'status', key: `truncated:${listing.path}`, depth, text: FOLDER_TRUNCATED });
    }
  };
  emit(root, 0);
  return rows;
}

/** Filter results: files only, flat, each with its folder as a dimmed prefix. */
export function searchRows(entries: ProjectFileEntry[]): EntryRow[] {
  return entries
    .filter((e) => e.type === 'file')
    .map((e) => {
      const slash = e.path.lastIndexOf('/') + 1;
      return {
        kind: 'entry',
        path: e.path,
        name: e.path.slice(slash),
        dir: e.path.slice(0, slash),
        isDir: false,
        depth: 0,
      };
    });
}

/** A search answer as received: for which filter text (`term`), in which chat and root (`scope`). */
export interface SearchShown {
  scope: string;
  term: string;
  result: ProjectFileSearchResult;
}

/**
 * What the filter shows:
 * - `results`: the answer for exactly the text in the box, in this scope (may be empty: "No files match");
 * - `narrowing`: while that answer is on its way, the matches of an earlier, shorter term this one extends (a superset),
 *   narrowed to the new text; never empty;
 * - `searching`: nothing on hand belongs to this text and scope;
 * - `error`: the search for exactly this text failed.
 */
export type SearchView =
  | { kind: 'results'; entries: ProjectFileEntry[]; truncated: ProjectFileSearchResult['truncated'] }
  | { kind: 'narrowing'; entries: ProjectFileEntry[] }
  | { kind: 'searching' }
  | { kind: 'error'; error: unknown };

/**
 * Picks what to show for the filter text `raw` (trimmed): `current` is the answer for the debounced term, `last` the
 * last answer received; `error` is the failure of the search for exactly `raw`, if any. Answers from another scope
 * (chat or root) are never used, and an earlier answer only while `raw` contains its term (case-insensitive, like the
 * server), since its matches then include every match of `raw`.
 */
export function searchView(args: {
  raw: string;
  scope: string;
  current: SearchShown | null;
  last: SearchShown | null;
  error: unknown;
}): SearchView {
  const { raw, scope, current, last, error } = args;
  if (current && current.scope === scope && current.term === raw) {
    return { kind: 'results', entries: current.result.entries, truncated: current.result.truncated };
  }
  if (error) return { kind: 'error', error };
  const needle = raw.toLowerCase();
  for (const base of [current, last]) {
    if (!base || base.scope !== scope || base.term === '' || !needle.includes(base.term.toLowerCase())) continue;
    const entries = base.result.entries.filter((e) => e.type === 'file' && e.path.toLowerCase().includes(needle));
    if (entries.length > 0) return { kind: 'narrowing', entries };
  }
  return { kind: 'searching' };
}

/**
 * Wording for a search that stopped early: `note` goes under the matches, `empty` replaces "No files match" when there
 * are none. `null` for a complete search. `home` picks "folder" over "project", as elsewhere in the panel.
 */
export function searchTruncationNote(
  truncated: ProjectFileSearchResult['truncated'],
  count: number,
  term: string,
  home: boolean,
): { note: string; empty?: string } | null {
  if (truncated === 'results') return { note: `Showing the first ${count} matches. Keep typing to narrow it down.` };
  if (truncated !== 'scanned') return null;
  const place = home ? 'folder' : 'project';
  return {
    note: `Only part of this ${place} was searched because it is large, so some matching files may be missing.`,
    empty: `No matches for “${term}” in the part of this ${place} that was searched. It is large, so some files were not searched.`,
  };
}
