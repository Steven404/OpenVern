// App-wide constants (plan §4.5).

export const APP_NAME = 'harness';
export const APP_ID = 'dev.stefanos.harness';
/** Picked from openrouter.ai/models on 2026-10-31: current Claude Sonnet with tools + image input. */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
export const NEW_CHAT_TITLE = 'New chat';
export const MAX_AGENT_STEPS = 25; // model calls per user turn

export const LIMITS = {
  attachmentsPerMessage: 10,
  textAttachmentBytes: 512 * 1024,
  imageAttachmentBytes: 10 * 1024 * 1024,
  readFileMaxLines: 2000,
  readFileMaxBytes: 100 * 1024,
  listFilesMaxEntries: 500,
  searchMaxMatches: 200,
  searchMaxFileBytes: 1024 * 1024,
  systemPromptTreeEntries: 100,
} as const;

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/** Extensions accepted as text attachments, on top of `text/*`. */
// biome-ignore format: compact list
export const TEXT_EXTENSIONS = [
  'md', 'mdx', 'txt', 'rst', 'adoc', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'properties', 'csv', 'tsv', 'xml', 'svg', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'jsx', 'mjs', 'cjs',
  'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'astro', 'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
  'm', 'mm', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'php', 'lua', 'pl', 'r', 'jl', 'sh', 'bash', 'zsh',
  'fish', 'ps1', 'bat', 'sql', 'graphql', 'gql', 'proto', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'scala',
  'groovy', 'gradle', 'zig', 'nim', 'v', 'sol', 'tf', 'hcl', 'nix', 'cmake', 'mk', 'dockerfile', 'gitignore',
  'editorconfig', 'lock', 'log', 'diff', 'patch',
] as const;

/** `accept` attribute for text files. */
export const TEXT_ACCEPT = ['text/*', ...TEXT_EXTENSIONS.map((e) => `.${e}`)].join(',');
/** `accept` attribute for images. */
export const IMAGE_ACCEPT = IMAGE_MIME_TYPES.join(',');

/** Header every `/api` request must carry (plan §3.3). */
export const CLIENT_HEADER = 'X-Harness-Client';
export const CLIENT_HEADER_VALUE = '1';
