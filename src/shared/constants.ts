// App-wide constants (plan §4.5).

import type { EditMode, ReasoningEffort } from './types';

export const APP_NAME = 'OpenVern';
/** Lower-case form for paths, the protocol host, storage keys and env vars. */
export const APP_SLUG = 'openvern';
export const APP_ID = 'dev.stefanos.openvern';
/** Picked from openrouter.ai/models on 2026-10-31: current Claude Sonnet with tools + image input. */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
export const NEW_CHAT_TITLE = 'New chat';
/**
 * Stands in for a chat id on the New Chat screen, before the chat exists: the right panel's state and the terminal
 * started there are kept under it, then moved to the chat on its first send. Never a real chat id (those are UUIDs).
 */
export const DRAFT_CHAT_ID = '__draft__';
/** Model calls per user turn. A cost backstop only: a stuck loop is stopped earlier by `MAX_REPEATED_TOOL_STEPS`. */
export const MAX_AGENT_STEPS = 100;
/** Stop a turn when this many consecutive steps make the same tool calls and get the same results. */
export const MAX_REPEATED_TOOL_STEPS = 6;
/** F1: OpenRouter is the only provider; the Context popover shows this label. */
export const PROVIDER_LABEL = 'OpenRouter';

/** F3: every level OpenRouter offers, weakest first. `null` (= Default) is not in the list. */
export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[];

/**
 * Compile-time check that the list above covers every `ReasoningEffort`: the argument resolves to `never` only
 * when nothing is missing, so adding a level to `ReasoningEffort` fails typecheck here until it is listed too.
 * Type-only: nothing is added at runtime.
 */
type AssertNever<T extends never> = T;
export type AllReasoningEffortsListed = AssertNever<Exclude<ReasoningEffort, (typeof REASONING_EFFORTS)[number]>>;

/** Every edit mode; `EditMode` documents what each one does. */
export const EDIT_MODES = ['review', 'auto'] as const satisfies readonly EditMode[];

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
  /** Building the project tree for the system prompt gives up after this long; the turn continues without it. */
  systemPromptTreeTimeoutMs: 2500,
  /** `.gitignore` files above this size are skipped by the walker (S3-M1). */
  gitignoreMaxBytes: 256 * 1024,
  /** v0.2 proposed edits (plan §4.5). */
  writeFileMaxBytes: 256 * 1024,
  pendingFilesPerChat: 50,
  /** Diff excerpt in an edit tool's output. */
  editResultDiffLines: 40,
  /** Files panel: direct children listed per folder; more sets `truncated`. */
  fileTreeFolderMaxEntries: 2_000,
  /** Files panel filter: matching files returned per search; more sets `truncated: 'results'`. */
  fileSearchMaxResults: 200,
  /** Files panel filter: entries a search walks before it stops and reports `truncated: 'scanned'`. */
  fileSearchMaxScanned: 50_000,
  /** Files panel filter: longest accepted query. */
  fileSearchMaxQueryLength: 1_000,
  viewerMaxBytes: 1024 * 1024,
  diffMaxLinesPerFile: 5_000,
  /** Auto batches per chat that keep the original file contents Undo needs. */
  autoUndoTurns: 20,
} as const;

export const LAYOUT = {
  sidebar: 272,
  conversationMin: 420,
  panelMin: 380,
  panelFiles: 380,
  panelDiffSplit: 800,
  /** Below this panel width Split is disabled. */
  splitMin: 640,
  windowMinWidth: 1080,
  windowMinHeight: 720,
} as const;

/**
 * The Diff surface's file list height as a fraction of the body below its header. The store owns the default (it
 * seeds the stored value); the helpers in `list-split.ts` clamp against the measured body.
 */
export const LIST_RATIO_DEFAULT = 0.35;

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
export const CLIENT_HEADER = 'X-OpenVern-Client';
export const CLIENT_HEADER_VALUE = '1';

/** Shown under the first assistant message of a turn when the project tree timed out. */
export const TREE_UNAVAILABLE_NOTICE = "Couldn't read the project folder in time; replied without its file structure.";
