import { defineConfig, mergeConfig } from 'vite';
import { rendererConfig } from './renderer.vite.ts';

export default defineConfig(
  mergeConfig(rendererConfig(), {
    build: { outDir: '../../out/web', emptyOutDir: true },
  }),
);
