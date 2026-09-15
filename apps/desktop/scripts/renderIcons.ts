import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { TRAY_DOT_COLORS, TRAY_GLYPH_COLORS, TRAY_IMAGE_FILES } from '../src/main/shell/trayIcon.js';
import { buildIco, unpremultiply, type IcoEntry } from './icons/ico.js';

/**
 * Renders the SVG sources in build/icons to the committed icon files. Run `npm run icons` after changing a source;
 * CI fails when the committed files differ from a fresh render.
 */

const appRoot = join(import.meta.dirname, '..');

function source(name: string): string {
  return readFileSync(join(appRoot, 'build', 'icons', name), 'utf8');
}

function render(svg: string, size: number): { pixels: Buffer; png: Buffer } {
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
  if (image.width !== size || image.height !== size) throw new Error(`rendered ${image.width}×${image.height}, expected ${size}×${size}`);
  return { pixels: image.pixels, png: image.asPng() };
}

function write(relativePath: string, data: Buffer): void {
  const path = join(appRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`wrote ${relativePath}`);
}

const full = source('app-full.svg');
const small = source('app-small.svg');
const dib = (svg: string, size: number): IcoEntry => ({ size, format: 'dib', rgba: unpremultiply(render(svg, size).pixels) });
const png = (svg: string, size: number): IcoEntry => ({ size, format: 'png', png: render(svg, size).png });

// Small sizes use the simplified artwork; bitmaps up to 64 px keep NSIS and older shell code happy.
write('build/icon.ico', buildIco([dib(small, 16), dib(small, 20), dib(small, 24), dib(small, 32), dib(full, 48), dib(full, 64), png(full, 128), png(full, 256)]));
write('build/icon-mac.png', render(source('app-mac.svg'), 1024).png);

const tray = source('tray.svg');
for (const spec of TRAY_IMAGE_FILES) {
  const svg = tray.replaceAll('{{glyph}}', TRAY_GLYPH_COLORS[spec.theme]).replaceAll('{{dot}}', TRAY_DOT_COLORS[spec.color]);
  write(spec.file, render(svg, spec.size).png);
}
