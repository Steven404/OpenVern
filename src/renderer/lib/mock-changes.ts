// Sample data for the v0.2 mock API: the design's "Review changes" proposal (3 files, 4 hunks) and a project file
// tree (docs/design/FilesPanel.dc.html, Files panel). Used by `MockApiClient` only.

import type {
  ChangeKind,
  ChangeSummary,
  DiffHunk,
  FileChange,
  HunkDecision,
  Id,
  ProjectFileContent,
  ProjectFileEntry,
  ProjectFileTree,
} from '@shared/types';

/** 8-char FNV-1a hex of the hunk's lines (the mock's stand-in for the server's hash). */
function hash8(lines: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of lines.join('\n')) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function makeHunk(oldStart: number, newStart: number, header: string, lines: string[]): DiffHunk {
  const oldLines = lines.filter((l) => l[0] !== '+').length;
  const newLines = lines.filter((l) => l[0] !== '-').length;
  return { id: `${oldStart}:${hash8(lines)}`, oldStart, oldLines, newStart, newLines, header, lines };
}

export function makeFileChange(path: string, kind: ChangeKind, hunks: DiffHunk[]): FileChange {
  const count = (c: string) => hunks.reduce((n, h) => n + h.lines.filter((l) => l[0] === c).length, 0);
  return { path, kind, add: count('+'), del: count('-'), hunks };
}

export function summarize(files: FileChange[], revision: number, messageId: Id): ChangeSummary {
  return {
    revision,
    messageId,
    files: files.map((f) => ({ path: f.path, kind: f.kind, add: f.add, del: f.del })),
    totalAdd: files.reduce((n, f) => n + f.add, 0),
    totalDel: files.reduce((n, f) => n + f.del, 0),
  };
}

/** Keeps only the accepted hunks of each file; files with none accepted are dropped. */
export function acceptedOnly(files: FileChange[], decisions: Record<string, Record<string, HunkDecision>>) {
  let rejectedHunks = 0;
  let skippedHunks = 0;
  const written: FileChange[] = [];
  for (const f of files) {
    const d = decisions[f.path] ?? {};
    const accepted = f.hunks.filter((h) => d[h.id] === 'accepted');
    rejectedHunks += f.hunks.filter((h) => d[h.id] === 'rejected').length;
    skippedHunks += f.hunks.filter((h) => d[h.id] === undefined).length;
    if (accepted.length > 0) written.push(makeFileChange(f.path, f.kind, accepted));
  }
  return { written, rejectedHunks, skippedHunks };
}

/** The design's sample proposal, sorted by path. */
export function sampleProposal(): FileChange[] {
  const writeFile = makeFileChange('src/core/tools/write-file.ts', 'create', [
    makeHunk(0, 1, '', [
      "+import { promises as fs } from 'node:fs';",
      "+import { LIMITS } from '@shared/constants';",
      "+import { CoreError } from '../errors';",
      "+import { resolveInside } from './sandbox';",
      "+import type { Tool } from './types';",
      '+',
      '+export type ConfirmWrite = (req: { path: string; bytes: number }, signal: AbortSignal) => Promise<boolean>;',
      '+',
      "+/** Creates or overwrites a file inside the project. Every call waits for the user's approval. */",
      '+export function writeFileTool(root: string, confirm: ConfirmWrite): Tool {',
      '+  return {',
      "+    name: 'write_file',",
      "+    description: 'Create or overwrite a UTF-8 text file inside the project.',",
      '+    async run({ path, content }, signal) {',
      '+      const target = await resolveInside(root, path);',
      '+      const bytes = Buffer.byteLength(content);',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source text for the diff
      "+      if (bytes > LIMITS.maxWriteBytes) throw new CoreError('too_large', `${path} is over the write limit.`);",
      '+      if (!(await confirm({ path, bytes }, signal))) {',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source text for the diff
      "+        throw new CoreError('tool_rejected', `Writing ${path} was declined.`);",
      '+      }',
      "+      await fs.writeFile(target, content, 'utf8');",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source text for the diff
      '+      return { ok: true, output: `Wrote ${bytes} bytes to ${path}`, summary: path };',
      '+    },',
      '+  };',
      '+}',
    ]),
  ]);
  const index = makeFileChange('src/core/tools/index.ts', 'modify', [
    makeHunk(4, 4, '', [
      " import { readFileTool } from './read-file';",
      " import { searchTool } from './search';",
      " import type { GetProjectTools, Tool } from './types';",
      "+import { type ConfirmWrite, writeFileTool } from './write-file';",
      ' ',
      " export { createWalker } from './walk';",
    ]),
    makeHunk(21, 22, 'export function createProjectTools', [
      ' /** The tools a chat gets for its project. */',
      '-export function createProjectTools(root: string): Tool[] {',
      '-  return [listFilesTool(root), readFileTool(root), searchTool(root)];',
      '+export function createProjectTools(root: string, confirm?: ConfirmWrite): Tool[] {',
      '+  const tools = [listFilesTool(root), readFileTool(root), searchTool(root)];',
      '+  // Write access is opt-in: without a confirm hook the project stays read-only.',
      '+  if (confirm) tools.push(writeFileTool(root, confirm));',
      '+  return tools;',
      ' }',
      ' ',
      ' export const getProjectTools: GetProjectTools = (project) =>',
      '-  createProjectTools(project.root);',
      '+  createProjectTools(project.root, project.confirmWrite);',
    ]),
  ]);
  const constants = makeFileChange('src/shared/constants.ts', 'modify', [
    makeHunk(42, 42, 'export const LIMITS = {', [
      '   searchMaxResults: 200,',
      '   readFileMaxBytes: 256 * 1024,',
      '+  /** Largest file write_file may create or overwrite. */',
      '+  maxWriteBytes: 256 * 1024,',
      ' } as const;',
    ]),
  ]);
  return [writeFile, index, constants];
}

const SAMPLE_FILE_PATHS = [
  'README.md',
  'package.json',
  'biome.json',
  'tsconfig.json',
  'build/icon.png',
  'build/icon.svg',
  'docs/design/canvas.json',
  'docs/design/Main.dc.html',
  'scripts/e2e/lib.sh',
  'scripts/e2e/smoke.mjs',
  'scripts/install-local.sh',
  'src/core/agent/history.ts',
  'src/core/agent/loop.ts',
  'src/core/agent/system-prompt.ts',
  'src/core/providers/openrouter.ts',
  'src/core/storage/chats.ts',
  'src/core/storage/paths.ts',
  'src/core/tools/index.ts',
  'src/core/tools/list-files.ts',
  'src/core/tools/read-file.ts',
  'src/core/tools/sandbox.ts',
  'src/core/tools/search.ts',
  'src/core/tools/types.ts',
  'src/core/index.ts',
  'src/core/types.ts',
  'src/main/index.ts',
  'src/renderer/app/App.tsx',
  'src/renderer/app/AppShell.tsx',
  'src/renderer/features/composer/Composer.tsx',
  'src/renderer/features/conversation/Conversation.tsx',
  'src/renderer/styles/tokens.css',
  'src/server/app.ts',
  'src/shared/api.ts',
  'src/shared/constants.ts',
  'src/shared/types.ts',
];

const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

/** Flat, depth-first listing: directories before files at each level, then case-insensitive name. */
export function sampleFileTree(): ProjectFileTree {
  type Node = { dirs: Map<string, Node>; files: string[] };
  const root: Node = { dirs: new Map(), files: [] };
  for (const p of SAMPLE_FILE_PATHS) {
    const parts = p.split('/');
    let node = root;
    for (const d of parts.slice(0, -1)) {
      const next = node.dirs.get(d) ?? { dirs: new Map(), files: [] };
      node.dirs.set(d, next);
      node = next;
    }
    node.files.push(parts[parts.length - 1] as string);
  }
  const entries: ProjectFileEntry[] = [];
  const walk = (node: Node, prefix: string) => {
    for (const d of [...node.dirs.keys()].sort(byName)) {
      entries.push({ path: `${prefix}${d}`, type: 'dir' });
      walk(node.dirs.get(d) as Node, `${prefix}${d}/`);
    }
    for (const f of [...node.files].sort(byName)) entries.push({ path: `${prefix}${f}`, type: 'file' });
  };
  walk(root, '');
  return { entries, truncated: false };
}

const SAMPLE_CONTENT: Record<string, string> = {
  'README.md': '# OpenVern\n\nA desktop AI app: chat with LLMs about your local code projects.\n',
  'src/core/tools/index.ts': [
    "import { listFilesTool } from './list-files';",
    "import { readFileTool } from './read-file';",
    "import { searchTool } from './search';",
    "import type { GetProjectTools, Tool } from './types';",
    '',
    "export { createWalker } from './walk';",
    '',
    '/** The tools a chat gets for its project. */',
    'export function createProjectTools(root: string): Tool[] {',
    '  return [listFilesTool(root), readFileTool(root), searchTool(root)];',
    '}',
    '',
  ].join('\n'),
};

export function sampleFileContent(path: string): ProjectFileContent | null {
  if (!SAMPLE_FILE_PATHS.includes(path)) return null;
  if (/\.(png|ico|jpg|jpeg|gif|webp)$/i.test(path)) {
    return { path, size: 2048, totalLines: 0, content: null, binary: true, truncated: false };
  }
  const content = SAMPLE_CONTENT[path] ?? `// ${path}\n// (sample content from the mock API)\n`;
  const totalLines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  return { path, size: content.length, totalLines, content, binary: false, truncated: false };
}
