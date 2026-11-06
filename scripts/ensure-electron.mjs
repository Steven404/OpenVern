#!/usr/bin/env node
// Preflight for `npm run dev` / `npm run preview`. electron-vite reads node_modules/electron/path.txt directly and,
// when it is absent, throws a bare "Electron uninstall" that says nothing about the cause. path.txt (and dist/) only
// exist once electron's postinstall has downloaded the binary, so a `npm ci --ignore-scripts`, a blocked download or an
// interrupted install all land here. Fail early with the actual fix instead.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let electronDir;
try {
  electronDir = dirname(require.resolve('electron/package.json'));
} catch {
  console.error('The `electron` package is not installed. Fix it with:\n\n  npm ci\n');
  process.exit(1);
}

const pathFile = join(electronDir, 'path.txt');
let executable = '';
try {
  executable = readFileSync(pathFile, 'utf8').trim();
} catch {
  // Missing path.txt: the postinstall never finished.
}

if (executable && existsSync(join(electronDir, 'dist', executable))) {
  process.exit(0);
}

console.error(
  [
    'The Electron binary is missing (node_modules/electron/dist is empty or path.txt is absent).',
    'Its postinstall download did not run — usually `npm ci --ignore-scripts`, a blocked download,',
    'or an install that was interrupted. Fetch it with:',
    '',
    '  node node_modules/electron/install.js',
    '',
  ].join('\n'),
);
process.exit(1);
