import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import { aliases, rendererConfig } from './renderer.vite.ts';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  main: {
    resolve: { alias: aliases },
    build: {
      rolldownOptions: { input: { index: fromRoot('./src/main/index.ts') } },
    },
  },
  preload: {
    resolve: { alias: aliases },
    build: {
      // Sandboxed preloads must be CommonJS.
      rolldownOptions: {
        input: { index: fromRoot('./src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    ...rendererConfig(),
    build: {
      rolldownOptions: { input: { index: fromRoot('./src/renderer/index.html') } },
    },
  },
});
