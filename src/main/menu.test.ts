import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { buildAppMenuTemplate } from './menu';

// Roles that the production macOS menu must not contain (AS-04: no View, Help, reload, DevTools, zoom or full screen).
const FORBIDDEN_ROLES = [
  'viewMenu',
  'help',
  'reload',
  'forceReload',
  'toggleDevTools',
  'resetZoom',
  'zoomIn',
  'zoomOut',
  'togglefullscreen',
];

/** Every item in the template, depth-first, including items nested under any `submenu` array. */
function collectItems(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? collectItems(item.submenu) : [])]);
}

describe('buildAppMenuTemplate (AS-04)', () => {
  it('darwin returns exactly the four roles, in order', () => {
    expect(buildAppMenuTemplate('darwin')).toStrictEqual([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]);
  });

  it('darwin has no forbidden role, accelerator or click anywhere in the tree', () => {
    const items = collectItems(buildAppMenuTemplate('darwin') ?? []);
    // The walk must at least visit the four top-level items; a vacuous walk would pass the loop below.
    expect(items.length).toBeGreaterThanOrEqual(4);
    for (const item of items) {
      expect(FORBIDDEN_ROLES).not.toContain(item.role);
      expect(item.accelerator).toBeUndefined();
      expect(item.click).toBeUndefined();
    }
  });

  it.each(['linux', 'win32', 'freebsd'] as const)('%s returns null (no application menu)', (platform) => {
    expect(buildAppMenuTemplate(platform)).toBeNull();
  });
});
