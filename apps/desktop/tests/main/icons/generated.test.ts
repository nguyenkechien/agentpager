import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readIcoDirectory } from '../../../scripts/icons/ico.js';
import { TRAY_IMAGE_FILES } from '../../../src/main/shell/trayIcon.js';

const appRoot = join(import.meta.dirname, '..', '..', '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(png: Buffer): [number, number] {
  expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe('generated icons (npm run icons)', () => {
  it('has every tray image at its size', () => {
    for (const spec of TRAY_IMAGE_FILES) {
      expect(pngSize(readFileSync(join(appRoot, spec.file))), spec.file).toEqual([spec.size, spec.size]);
    }
  });

  it('has a 1024 px macOS icon', () => {
    expect(pngSize(readFileSync(join(appRoot, 'build', 'icon-mac.png')))).toEqual([1024, 1024]);
  });

  it('has a Windows icon with bitmaps up to 64 px and PNG for 128 and 256', () => {
    const ico = readFileSync(join(appRoot, 'build', 'icon.ico'));
    const directory = readIcoDirectory(ico);
    expect(directory.map((entry) => entry.size)).toEqual([16, 20, 24, 32, 48, 64, 128, 256]);
    for (const entry of directory) {
      const image = ico.subarray(entry.offset, entry.offset + entry.bytes);
      if (entry.size <= 64) expect(image.readUInt32LE(0), `${entry.size}px`).toBe(40);
      else expect(pngSize(image)).toEqual([entry.size, entry.size]);
    }
  });
});
