import type { ProjectFileEntry } from '@shared/types';

export interface TreeRow {
  path: string;
  name: string;
  /** Dimmed `dir/` prefix (filter results only). */
  dir: string;
  isDir: boolean;
  depth: number;
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Rows to draw. Without a filter: the depth-first entries whose ancestors are all expanded. With a filter: matching
 * files only, flat, each with its folder as a dimmed prefix.
 */
export function buildRows(entries: ProjectFileEntry[], expanded: Record<string, true>, query: string): TreeRow[] {
  const q = query.trim().toLowerCase();
  if (q) {
    return entries
      .filter((e) => e.type === 'file' && e.path.toLowerCase().includes(q))
      .map((e) => {
        const slash = e.path.lastIndexOf('/') + 1;
        return { path: e.path, name: e.path.slice(slash), dir: e.path.slice(0, slash), isDir: false, depth: 0 };
      });
  }
  const rows: TreeRow[] = [];
  const open = new Set<string>(); // folders that are expanded *and* shown
  for (const e of entries) {
    const slash = e.path.lastIndexOf('/');
    const parent = slash < 0 ? '' : e.path.slice(0, slash);
    if (parent !== '' && !open.has(parent)) continue;
    rows.push({
      path: e.path,
      name: baseName(e.path),
      dir: '',
      isDir: e.type === 'dir',
      depth: parent === '' ? 0 : parent.split('/').length,
    });
    if (e.type === 'dir' && expanded[e.path]) open.add(e.path);
  }
  return rows;
}
