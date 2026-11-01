// System prompt construction (S4.9). Pure: the caller supplies the date, project and rendered tree.

import { APP_NAME, LIMITS } from '@shared/constants';

export interface SystemPromptInput {
  now: Date;
  /** Present when the chat belongs to a project. */
  project?: { name: string; rootPath: string };
  /** True when project tools are actually offered for this request (project chat + model supports tools). */
  hasTools: boolean;
  /** Output of `renderTree`; used in every project prompt. */
  tree?: string;
}

/** Local calendar date as `YYYY-MM-DD`. */
export function formatDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function buildSystemPrompt({ now, project, hasTools, tree }: SystemPromptInput): string {
  const date = formatDate(now);
  if (!project) {
    return [
      `You are ${APP_NAME}, a helpful AI assistant in a desktop app.`,
      `Today's date is ${date}.`,
      'Answer in Markdown. Be direct and concise; use fenced code blocks (with a language) for code.',
    ].join('\n');
  }

  const header = [
    `You are ${APP_NAME}, a coding assistant in a desktop app. The user is chatting with you about a local code project.`,
    `Today's date is ${date}.`,
    '',
    `Project: ${project.name}`,
    `Project root: ${project.rootPath}`,
  ];

  const treeLines = (): string[] =>
    tree?.trim()
      ? [
          '',
          `Top of the project tree (depth 2, at most ${LIMITS.systemPromptTreeEntries} entries):`,
          '```',
          tree.trimEnd(),
          '```',
        ]
      : [];

  if (!hasTools) {
    return [
      ...header,
      '',
      "This chat is attached to the project above, but the selected model can't use tools, so you cannot open or search its files. You can only see the top of its folder structure (below).",
      "Don't guess about file contents. If you need to see code, ask the user to paste it or to pick a model that supports tools.",
      '',
      'Answer in Markdown. Use fenced code blocks (with a language) for code.',
      ...treeLines(),
    ].join('\n');
  }

  const out = [
    ...header,
    '',
    'You can explore the project with read-only tools:',
    '- list_files: list a directory as a tree.',
    '- read_file: read a file (optionally a line range). Large files are truncated; request further ranges if needed.',
    '- search: find text or a regular expression across files.',
    '',
    'Limits and rules:',
    '- You cannot modify files or run commands. If the user asks for a change, show the code in your answer so they can apply it.',
    '- Read before you claim: never state what a file contains, or that something does or does not exist, without having looked. If you have not checked, say so.',
    '- All paths are relative to the project root. Do not use absolute paths or `..`.',
    '- Files that look like secrets (.env, private keys) are blocked, and ignored folders (node_modules, .git, build output) are hidden.',
    '- Prefer a few targeted tool calls over reading everything.',
    '',
    'Answer in Markdown. Use fenced code blocks (with a language) for code, and mention file paths in backticks.',
  ];
  out.push(...treeLines());
  return out.join('\n');
}
