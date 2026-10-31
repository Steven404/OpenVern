// Test helper: builds a throwaway fixture project (and a sibling "outside" folder) in the OS temp dir.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext } from './types';

export interface Fixture {
  /** Project root. */
  root: string;
  /** A folder next to the project that tools must never reach. */
  outside: string;
  ctx: ToolContext;
  cleanup(): Promise<void>;
}

export async function write(root: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

export async function createFixture(): Promise<Fixture> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'harness-tools-')));
  const root = path.join(base, 'proj');
  const outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);

  await write(outside, 'secret.txt', 'outside secret NEEDLE');
  await write(outside, 'dir/inner.txt', 'outside inner');

  await write(root, '.gitignore', '*.log\n/secret-dir/\n');
  await write(root, 'README.md', '# Fixture\n\nA tiny project.\n');
  await write(
    root,
    'src/index.ts',
    "export const greeting = 'Hello World';\n// TODO: fix this\nexport function main() {\n  return greeting;\n}\n",
  );
  await write(
    root,
    'src/util.test.ts',
    "import { greeting } from './index';\nconsole.log(greeting, 'needle in test');\n",
  );
  await write(root, 'src/components/Button.tsx', 'export const Button = () => <button>NEEDLE button</button>;\n');
  await write(root, 'src/nested/.gitignore', 'generated.ts\n!keep.log\n');
  await write(root, 'src/nested/generated.ts', 'export const needle = "generated";\n');
  await write(root, 'src/nested/keep.log', 'kept log needle\n');
  await write(root, 'src/nested/a.ts', 'export const a = 1;\n');
  await write(root, 'debug.log', 'ignored log needle\n');
  await write(root, 'secret-dir/x.txt', 'ignored dir needle\n');

  // Always-skipped directories.
  for (const dir of [
    'node_modules/pkg',
    'dist',
    'build',
    'out',
    '.next',
    '.turbo',
    '.cache',
    'coverage',
    'target',
    '.venv',
    'venv',
    '__pycache__',
  ]) {
    await write(root, `${dir}/index.js`, 'skipped needle\n');
  }

  // Secrets and git internals.
  await write(root, '.env', 'API_KEY=needle-secret\n');
  await write(root, '.env.local', 'API_KEY=needle-secret\n');
  await write(root, '.env.example', 'API_KEY=needle-example\n');
  await write(root, '.env.sample', 'API_KEY=needle-sample\n');
  await write(root, 'certs/server.pem', 'needle pem\n');
  await write(root, 'certs/server.key', 'needle key\n');
  await write(root, 'certs/server.p12', 'needle p12\n');
  await write(root, 'ssh/id_rsa', 'needle rsa\n');
  await write(root, 'ssh/id_rsa.pub', 'needle rsa pub\n');
  await write(root, 'ssh/id_ed25519', 'needle ed\n');
  await write(root, '.git/config', '[core]\n  needle = 1\n');
  await write(root, '.git/HEAD', 'ref: refs/heads/main\n');

  // Binary + oversized + long files.
  await write(root, 'bin/blob.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  await write(root, 'big.txt', `needle at the start\n${'x'.repeat(1024 * 1024 + 10)}\n`);
  await write(root, 'lines.txt', `${Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n')}\n`);
  await write(root, 'empty.txt', '');

  // Symlinks.
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link-out-file'));
  await symlink(path.join(outside, 'dir'), path.join(root, 'link-out-dir'));
  await symlink(path.join(root, 'src', 'index.ts'), path.join(root, 'link-in'));
  await symlink(path.join(root, '.env'), path.join(root, 'link-env'));

  return {
    root,
    outside,
    ctx: { projectRoot: root, signal: new AbortController().signal },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}
