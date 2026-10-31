// Lazy Shiki (S7.5). Uses the fine-grained core + the JavaScript regex engine (no wasm), and one dynamic import
// per language, so none of it lands in the main chunk. Unknown languages render as plain mono text.

import type { HighlighterCore, ThemedToken } from 'shiki/core';
import { createHarnessTheme, SHIKI_THEME_NAME } from '../../styles/shiki-theme';

type LangModule = Promise<{ default: Parameters<HighlighterCore['loadLanguage']>[0] }>;

/** Canonical language id → loader. Add entries here; each becomes its own chunk. */
const LOADERS: Record<string, () => LangModule> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  shellscript: 'bash',
  console: 'bash',
  py: 'python',
  md: 'markdown',
  yml: 'yaml',
  rs: 'rust',
  kt: 'kotlin',
  'c++': 'cpp',
  cc: 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  rb: 'ruby',
  patch: 'diff',
  docker: 'dockerfile',
  htm: 'html',
  gql: 'graphql',
};

/** Canonical Shiki language for a fence info string (`ts`, `language-ts`, `TypeScript`…), or `null`. */
export function resolveLanguage(lang: string | undefined | null): string | null {
  if (!lang) return null;
  const key = lang.toLowerCase().replace(/^language-/, '');
  const canonical = ALIASES[key] ?? key;
  return canonical in LOADERS ? canonical : null;
}

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      themes: [createHarnessTheme()],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

export type HighlightedLine = Array<Pick<ThemedToken, 'content' | 'color' | 'fontStyle'>>;

/** Tokenises `code`; resolves `null` when the language is unknown or Shiki fails (caller shows plain text). */
export async function highlightCode(code: string, lang: string | null | undefined): Promise<HighlightedLine[] | null> {
  const canonical = resolveLanguage(lang);
  if (!canonical) return null;
  try {
    const hl = await getHighlighter();
    let ready = loaded.get(canonical);
    if (!ready) {
      const load = LOADERS[canonical];
      if (!load) return null;
      ready = load().then((m) => hl.loadLanguage(m.default));
      loaded.set(canonical, ready);
    }
    await ready;
    const { tokens } = hl.codeToTokens(code, { lang: canonical, theme: SHIKI_THEME_NAME });
    return tokens;
  } catch {
    return null;
  }
}
