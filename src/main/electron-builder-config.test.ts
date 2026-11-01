import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Text checks only: js-yaml is not a direct dependency.
const yml = readFileSync(path.resolve(import.meta.dirname, '../../electron-builder.yml'), 'utf8');

function topLevelBlock(key: string): string {
  const lines = yml.split('\n');
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^[^\s#]/.test(l));
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

describe('electron-builder.yml (S8-N2)', () => {
  it('sets linux.executableArgs to [] so the AppImage .desktop Exec has no --no-sandbox', () => {
    expect(topLevelBlock('linux')).toMatch(/^ {2}executableArgs: \[\]\s*$/m);
  });

  it('never mentions no-sandbox', () => {
    expect(yml).not.toContain('no-sandbox');
  });
});
