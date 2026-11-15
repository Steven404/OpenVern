// T0.3 spike config: the app's real `main` build (electron.vite.config.ts) with only the entry swapped for ./main.ts.
// No preload or renderer: the spike opens no window. Usage is in ./main.ts.
import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'electron-vite';
import appConfig from '../../../electron.vite.config.ts';

const main = (appConfig as UserConfig).main ?? {};

export default defineConfig({
  main: {
    ...main,
    build: {
      ...main.build,
      rolldownOptions: {
        ...main.build?.rolldownOptions,
        input: { index: fileURLToPath(new URL('./main.ts', import.meta.url)) },
      },
    },
  },
});
