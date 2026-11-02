// Shiki theme built from the design tokens (plan §5.1): keywords use `--color-accent-2`, strings `--color-success`,
// numbers / functions `--color-accent`, comments `--color-text-faint`. Values are read from the CSS custom
// properties at runtime so a token change flows through; the fallbacks mirror `tokens.css`.

import type { ThemeRegistration } from 'shiki/core';

export const SHIKI_THEME_NAME = 'openvern';

const FALLBACKS = {
  code: '#0a0d1c',
  'text-code': '#e2e7f5',
  'text-muted': '#9ba5c6',
  'text-faint': '#8792b6',
  accent: '#f6bd60',
  'accent-2': '#e5865f',
  success: '#9fd4b3',
  danger: '#ff8f87',
} as const;

type TokenName = keyof typeof FALLBACKS;

function token(name: TokenName): string {
  if (typeof document === 'undefined') return FALLBACKS[name];
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
  return value || FALLBACKS[name];
}

export function createOpenVernTheme(): ThemeRegistration {
  const fg = token('text-code');
  const keyword = token('accent-2');
  const string = token('success');
  const accent = token('accent');
  const faint = token('text-faint');
  const muted = token('text-muted');
  return {
    name: SHIKI_THEME_NAME,
    type: 'dark',
    colors: { 'editor.background': token('code'), 'editor.foreground': fg },
    fg,
    bg: token('code'),
    settings: [
      { settings: { foreground: fg } },
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: faint, fontStyle: 'italic' } },
      {
        scope: [
          'keyword',
          'keyword.control',
          'keyword.operator.new',
          'keyword.operator.expression',
          'keyword.operator.logical',
          'storage',
          'storage.type',
          'storage.modifier',
          'variable.language',
          'constant.language',
          'support.type.primitive',
        ],
        settings: { foreground: keyword },
      },
      {
        scope: ['string', 'string.quoted', 'string.template', 'markup.inline.raw', 'punctuation.definition.string'],
        settings: { foreground: string },
      },
      {
        scope: ['constant.numeric', 'constant.character', 'constant.other', 'support.constant'],
        settings: { foreground: accent },
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'meta.function-call entity.name.function',
          'entity.name.tag',
          'entity.name.type',
          'entity.name.class',
          'support.class',
          'support.type',
        ],
        settings: { foreground: accent },
      },
      {
        scope: ['punctuation', 'meta.brace', 'keyword.operator', 'meta.delimiter'],
        settings: { foreground: muted },
      },
      {
        scope: ['entity.other.attribute-name', 'support.type.property-name', 'meta.object-literal.key'],
        settings: { foreground: fg },
      },
      { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: keyword, fontStyle: 'bold' } },
      { scope: ['markup.inserted', 'meta.diff.header.to-file'], settings: { foreground: string } },
      { scope: ['markup.deleted', 'meta.diff.header.from-file', 'invalid'], settings: { foreground: token('danger') } },
    ],
  };
}
