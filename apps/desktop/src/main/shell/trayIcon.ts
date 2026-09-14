import { crc32, deflateSync } from 'node:zlib';
import type { TrayColor } from './trayModel.js';

const RGB: Record<TrayColor, readonly [number, number, number]> = {
  green: [34, 197, 94],
  amber: [245, 158, 11],
  grey: [148, 163, 184],
  red: [239, 68, 68],
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/**
 * A filled, anti-aliased status dot as an RGBA PNG. PNG rather than a raw bitmap: `nativeImage.createFromBitmap`
 * expects the platform's own pixel order.
 */
export function circlePng(color: TrayColor, size: number): Buffer {
  const [red, green, blue] = RGB[color];
  const center = (size - 1) / 2;
  const radius = size * 0.4;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) {
    // Each scanline starts with filter type 0 (none).
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x - center, y - center)));
      const offset = 1 + x * 4;
      row[offset] = red;
      row[offset + 1] = green;
      row[offset + 2] = blue;
      row[offset + 3] = Math.round(coverage * 255);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
