// Regenerates build/icon.png (512x512) from build/icon.svg. Usage: node build/make-icon.mjs
// On macOS it writes build/icon.icns instead: the standard iconset (16-1024 px, incl. @2x) rendered from the same SVG
// and packed with the system `iconutil`. build/icon.png is left as it is on macOS.
// Needs a system SVG rasteriser (no npm dependency): rsvg-convert (librsvg) or ImageMagick (`magick`).
// electron-builder derives the other Linux sizes from this 512x512 PNG.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const svg = fileURLToPath(new URL('./icon.svg', import.meta.url));
const png = fileURLToPath(new URL('./icon.png', import.meta.url));
const icns = fileURLToPath(new URL('./icon.icns', import.meta.url));

// Standard macOS iconset: [file name, pixel size]. Pixel size = logical size x scale.
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

const rasterisers = [
  {
    cmd: 'rsvg-convert',
    args: (size, out) => ['-w', String(size), '-h', String(size), '-o', out, svg],
  },
  {
    cmd: 'magick',
    args: (size, out) => ['-background', 'none', '-density', '384', svg, '-resize', `${size}x${size}`, `PNG32:${out}`],
  },
];

// Renders the SVG at size x size into out with the first rasteriser that works. Returns the command used.
function renderPng(size, out) {
  const failures = [];
  for (const { cmd, args } of rasterisers) {
    const result = spawnSync(cmd, args(size, out), { encoding: 'utf8' });
    if (result.error) {
      failures.push(result.error.code === 'ENOENT' ? `${cmd} is not installed` : `${cmd}: ${result.error.message}`);
      continue;
    }
    if (result.status === 0) return cmd;
    const stderr = (result.stderr ?? '').trim();
    failures.push(`${cmd} exited with ${result.status}${stderr ? `: ${stderr}` : ''}`);
  }
  throw new Error(
    `could not render ${size}px PNG from ${svg} (${failures.join('; ')}). Install librsvg (rsvg-convert) or ImageMagick.`,
  );
}

// Builds build/icon.icns. Work happens in a temp dir that is always removed; the output is copied only on success,
// so a failed run never leaves a partial icon.icns behind.
function buildIcns() {
  const work = mkdtempSync(join(tmpdir(), 'openvern-icns-'));
  try {
    const iconset = join(work, 'OpenVern.iconset');
    mkdirSync(iconset);
    for (const [name, size] of ICONSET) {
      renderPng(size, join(iconset, name));
    }

    const packed = join(work, 'icon.icns');
    const result = spawnSync('iconutil', ['-c', 'icns', '-o', packed, iconset], { encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') {
      throw new Error('iconutil is not installed. It ships with macOS (/usr/bin/iconutil).');
    }
    if (result.status !== 0) {
      const stderr = (result.stderr ?? '').trim();
      throw new Error(`iconutil exited with ${result.status}${stderr ? `: ${stderr}` : ''}`);
    }
    copyFileSync(packed, icns);
    console.log(`wrote ${icns} (iconset 16-1024 px, incl. @2x) using iconutil`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  if (process.platform === 'darwin') {
    // The 512 px iconset entry comes from the same SVG. build/icon.png is deliberately not rewritten here: a re-render
    // on macOS changes the PNG bytes (pixels are identical), and the Linux asset should stay byte-stable.
    buildIcns();
    return;
  }

  const cmd = renderPng(512, png);
  console.log(`wrote ${png} using ${cmd}`);
}

try {
  main();
} catch (error) {
  console.error(`make-icon: ${error.message}`);
  process.exitCode = 1;
}
