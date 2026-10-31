import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { aliases } from './renderer.vite.ts';

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/{shared,core,server}/**/*.test.ts'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
