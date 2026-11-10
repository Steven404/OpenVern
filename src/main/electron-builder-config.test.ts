import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Text checks only: js-yaml is not a direct dependency.
const yml = readFileSync(path.resolve(import.meta.dirname, '../../electron-builder.yml'), 'utf8');
const scripts = (
  JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as {
    scripts: Record<string, string | undefined>;
  }
).scripts;

// Literals captured before AS-10. The Linux artifact name must stay byte-identical.
// biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder placeholders, not JS templates
const CURRENT_TOP_LEVEL_ARTIFACT_NAME = 'OpenVern-${version}-x86_64.${ext}';
const CURRENT_DIST_SCRIPT = 'electron-vite build && electron-builder --linux AppImage';
// Target literals from the AS-10 plan (§7 scope items 2 and 4).
// biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder placeholders, not JS templates
const MAC_ARTIFACT_NAME = 'OpenVern-${version}-arm64.${ext}';
const DIST_MAC_SCRIPT = 'electron-vite build && electron-builder --mac --arm64';

function topLevelBlock(key: string): string {
  const lines = yml.split('\n');
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^[^\s#]/.test(l));
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

function leadingWs(line: string): number {
  return line.length - line.trimStart().length;
}

// Value of the first `key:` line in the block (any depth), without quotes or trailing comments.
function scalar(block: string, key: string): string | undefined {
  const m = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, 'm').exec(block);
  if (!m) return undefined;
  return (m[1] ?? '')
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2');
}

// Lines nested under a `key:` line (deeper indent only). '' when the key is absent.
function nestedBlock(block: string, key: string): string {
  const lines = block.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^[ \\t]*${key}:[ \\t]*$`).test(l));
  if (start < 0) return '';
  const indent = leadingWs(lines[start] ?? '');
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && leadingWs(line) <= indent) break;
    out.push(line);
  }
  return out.join('\n');
}

// Target names: `- target: X`, `target: X`, `target: [X, Y]`, or `- X` list items under `target:`.
function targetNames(block: string): string[] {
  const names: string[] = [];
  for (const m of block.matchAll(/^[ \t]*-[ \t]+target:[ \t]*([A-Za-z0-9]+)/gm)) names.push(m[1] ?? '');
  for (const m of block.matchAll(/^[ \t]*target:[ \t]*([A-Za-z0-9]+)[ \t]*$/gm)) names.push(m[1] ?? '');
  for (const m of block.matchAll(/^[ \t]*target:[ \t]*\[([^\]\n]*)\]/gm)) {
    names.push(...(m[1] ?? '').split(',').map((s) => s.trim()));
  }
  for (const line of nestedBlock(block, 'target').split('\n')) {
    const m = /^[ \t]*-[ \t]+([A-Za-z0-9]+)[ \t]*$/.exec(line);
    if (m) names.push(m[1] ?? '');
  }
  return names.filter(Boolean);
}

// Every `arch` value in the block: inline (`arch: arm64`, `arch: [arm64]`) or list items under `arch:`.
function archValues(block: string): string[] {
  const lines = block.split('\n');
  const values: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:-\s+)?arch:\s*(.*?)\s*$/.exec(line);
    if (!m) return;
    const inline = (m[2] ?? '').replace(/\s+#.*$/, '').trim();
    if (inline !== '') {
      values.push(
        ...inline
          .replace(/[[\]]/g, '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      return;
    }
    const indent = (m[1] ?? '').length;
    for (const next of lines.slice(i + 1)) {
      const item = /^(\s*)-\s+(\S+)\s*$/.exec(next);
      if (!item || (item[1] ?? '').length <= indent) break;
      values.push(item[2] ?? '');
    }
  });
  return values;
}

const linux = topLevelBlock('linux');
const mac = topLevelBlock('mac');

describe('electron-builder.yml (S8-N2)', () => {
  it('sets linux.executableArgs to [] so the AppImage .desktop Exec has no --no-sandbox', () => {
    expect(topLevelBlock('linux')).toMatch(/^ {2}executableArgs: \[\]\s*$/m);
  });

  it('never mentions no-sandbox', () => {
    expect(yml).not.toContain('no-sandbox');
  });
});

describe('electron-builder.yml mac block (AS-10)', () => {
  it('has a top-level mac block', () => {
    expect(mac.trim()).not.toBe('');
  });

  it('builds exactly the dir and dmg targets', () => {
    expect([...new Set(targetNames(mac))].sort()).toEqual(['dir', 'dmg']);
  });

  it('is arm64 only (no x64, universal or other arch)', () => {
    expect(new Set(archValues(mac))).toEqual(new Set(['arm64']));
  });

  it('signs ad hoc with identity "-"', () => {
    expect(scalar(mac, 'identity')).toBe('-');
  });

  it('turns hardenedRuntime off', () => {
    expect(scalar(mac, 'hardenedRuntime')).toBe('false');
  });

  it('sets the developer-tools category', () => {
    expect(scalar(mac, 'category')).toBe('public.app-category.developer-tools');
  });

  it('uses build/icon.icns as the app icon', () => {
    expect(scalar(mac, 'icon')).toBe('build/icon.icns');
  });

  it('sets no minimumSystemVersion (D1: inherit the locked Electron floor)', () => {
    expect(mac.trim()).not.toBe('');
    expect(scalar(mac, 'minimumSystemVersion')).toBeUndefined();
  });

  const extendInfo = nestedBlock(mac, 'extendInfo');
  it.each([
    'NSDocumentsFolderUsageDescription',
    'NSDesktopFolderUsageDescription',
    'NSDownloadsFolderUsageDescription',
  ])('declares a non-empty %s under extendInfo (D9)', (key) => {
    expect(scalar(extendInfo, key)).toBeTruthy();
  });
});

describe('electron-builder.yml artifact names (AS-10, B5)', () => {
  it('has no top-level artifactName', () => {
    expect(yml).not.toMatch(/^artifactName:/m);
  });

  it('linux.artifactName is identical to the old top-level string', () => {
    expect(scalar(linux, 'artifactName')).toBe(CURRENT_TOP_LEVEL_ARTIFACT_NAME);
  });

  it('mac.artifactName is the arm64 name from the AS-10 plan', () => {
    expect(scalar(mac, 'artifactName')).toBe(MAC_ARTIFACT_NAME);
  });
});

describe('electron-builder.yml linux block (controls, unchanged by AS-10)', () => {
  it('keeps the AppImage x64 target', () => {
    expect(targetNames(linux)).toEqual(['AppImage']);
    expect(archValues(linux)).toEqual(['x64']);
  });

  it.each([
    ['category', 'Development'],
    ['icon', 'build/icon.png'],
    ['synopsis', 'Chat with LLMs about your local code projects'],
    ['StartupWMClass', 'openvern'],
  ])('keeps linux.%s = %s', (key, value) => {
    expect(scalar(linux, key)).toBe(value);
  });
});

describe('electron-builder.yml secrets (AS-10)', () => {
  it('holds no CSC_ or APPLE_ values', () => {
    expect(yml).not.toMatch(/CSC_|APPLE_/);
  });
});

describe('package.json scripts (AS-10)', () => {
  it('keeps the dist script unchanged (Linux AppImage)', () => {
    expect(scripts.dist).toBe(CURRENT_DIST_SCRIPT);
  });

  it('adds dist:mac as an arm64 mac build', () => {
    expect(scripts['dist:mac']).toBe(DIST_MAC_SCRIPT);
  });

  it('dist:mac has no credential variables and no no-sandbox flag', () => {
    expect(scripts['dist:mac']).toBeDefined();
    expect(scripts['dist:mac'] ?? '').not.toMatch(/CSC_|APPLE_|no-sandbox/);
  });
});

describe('electron fuses (AS-12, D4)', () => {
  const fuses = topLevelBlock('electronFuses');
  it('defines the fuses at top level for both platforms', () => {
    expect(yml).toMatch(/^electronFuses:\s*$/m);
    expect(fuses.trim()).not.toBe('');
  });
  it.each([
    ['runAsNode', 'false'],
    ['enableNodeOptionsEnvironmentVariable', 'false'],
    ['enableNodeCliInspectArguments', 'false'],
    ['onlyLoadAppFromAsar', 'true'],
    ['enableEmbeddedAsarIntegrityValidation', 'true'],
    ['grantFileProtocolExtraPrivileges', 'false'],
  ])('sets %s to %s', (key, value) => {
    expect(fuses).toMatch(new RegExp(`^  ${key}: ${value}\\s*(?:#.*)?$`, 'm'));
  });
  it('leaves cookie encryption untouched', () => {
    expect(scalar(fuses, 'enableCookieEncryption')).toBeUndefined();
  });
  it('does not add signing credentials or notarization and keeps hardened runtime off', () => {
    expect(yml).not.toMatch(/CSC_|APPLE_|notarize/i);
    expect(scalar(mac, 'hardenedRuntime')).toBe('false');
  });
});
