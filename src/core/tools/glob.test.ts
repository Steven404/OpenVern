import { describe, expect, it } from 'vitest';
import { compileGlob, expandBraces } from './glob';

function matcher(glob: string) {
  const res = compileGlob(glob);
  if (!res.ok) throw new Error(res.message);
  return res.matches;
}

describe('expandBraces', () => {
  it('expands groups, including several and nested', () => {
    expect(expandBraces('*.{ts,tsx}')).toEqual(['*.ts', '*.tsx']);
    expect(expandBraces('{a,b}/{c,d}')).toEqual(['a/c', 'a/d', 'b/c', 'b/d']);
    expect(expandBraces('x.{a,b{1,2}}')).toEqual(['x.a', 'x.b1', 'x.b2']);
    expect(expandBraces('plain')).toEqual(['plain']);
    expect(expandBraces('unbalanced{a,b')).toEqual(['unbalanced{a,b']);
  });
});

describe('compileGlob', () => {
  it('matches basenames at any depth when the pattern has no slash', () => {
    const m = matcher('*.ts');
    expect(m('a.ts')).toBe(true);
    expect(m('src/deep/a.ts')).toBe(true);
    expect(m('a.tsx')).toBe(false);
  });

  it('anchors patterns containing a slash at the project root', () => {
    const m = matcher('src/*.ts');
    expect(m('src/a.ts')).toBe(true);
    expect(m('src/deep/a.ts')).toBe(false);
    expect(m('other/src/a.ts')).toBe(false);
    expect(matcher('src/**/*.tsx')('src/a/b/c.tsx')).toBe(true);
    expect(matcher('**/*.test.ts')('src/x/y.test.ts')).toBe(true);
  });

  it('supports braces and a leading ./', () => {
    const m = matcher('./*.{ts,tsx}');
    expect(m('x/a.tsx')).toBe(true);
    expect(m('x/a.js')).toBe(false);
  });

  it('rejects empty and negated globs', () => {
    expect(compileGlob('  ').ok).toBe(false);
    expect(compileGlob('!*.ts').ok).toBe(false);
  });
});
