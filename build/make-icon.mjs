// Regenerates build/icon.png (512x512) from build/icon.svg. Usage: node build/make-icon.mjs
// Needs a system SVG rasteriser (no npm dependency): rsvg-convert (librsvg) or ImageMagick (`magick`).
// electron-builder derives the other Linux sizes from this 512x512 PNG.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const svg = fileURLToPath(new URL('./icon.svg', import.meta.url));
const png = fileURLToPath(new URL('./icon.png', import.meta.url));

const attempts = [
  ['rsvg-convert', ['-w', '512', '-h', '512', '-o', png, svg]],
  ['magick', ['-background', 'none', '-density', '384', svg, '-resize', '512x512', `PNG32:${png}`]],
];

for (const [cmd, args] of attempts) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status === 0) {
    console.log(`wrote ${png} using ${cmd}`);
    process.exit(0);
  }
}
console.error('Could not render the icon: install librsvg (rsvg-convert) or ImageMagick.');
process.exit(1);
