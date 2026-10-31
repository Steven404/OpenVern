import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { UserConfig } from 'vite';

/** Address of the standalone dev API server (`npm run dev:server`). */
export const DEV_API_TARGET = 'http://127.0.0.1:8787';
export const DEV_RENDERER_PORT = 5173;

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Path aliases shared by every build (renderer, main, preload, server via tsx, Vitest). */
export const aliases = {
  '@shared': fromRoot('./src/shared'),
  '@core': fromRoot('./src/core'),
  '@server': fromRoot('./src/server'),
  '@renderer': fromRoot('./src/renderer'),
};

/** Renderer config used by both `vite.web.config.ts` and the `renderer` entry of `electron.vite.config.ts`. */
export function rendererConfig(): UserConfig {
  return {
    root: fromRoot('./src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: { alias: aliases },
    server: {
      host: 'localhost',
      port: DEV_RENDERER_PORT,
      strictPort: true,
      proxy: {
        // Keep the original Host header (`localhost:5173`); the API accepts `localhost` on any port.
        '/api': { target: DEV_API_TARGET },
      },
    },
  };
}
