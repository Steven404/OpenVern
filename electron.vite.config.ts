import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import { aliases, rendererConfig } from './renderer.vite.ts';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  main: {
    resolve: { alias: aliases },
    build: {
      // Bundle hono, zod, ignore, eventsource-parser… into out/main/index.js so the AppImage needs no node_modules
      // (`electron` and Node built-ins stay external).
      externalizeDeps: false,
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
