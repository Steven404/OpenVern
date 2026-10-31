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
      // electron-vite defaults the renderer to `minify: false`; the web build (plain Vite) minifies.
      minify: true,
      // The prod CSP is `font-src 'self'`: keep every font a real file (Vite would inline the small unicode-range
      // subsets as `data:` URIs, which that CSP blocks).
      assetsInlineLimit: (file: string) => (file.endsWith('.woff2') ? false : undefined),
      rolldownOptions: { input: { index: fromRoot('./src/renderer/index.html') } },
    },
  },
});
