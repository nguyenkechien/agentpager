import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { circlePng } from '../../../src/main/shell/trayIcon.js';

interface Chunk {
  type: string;
  data: Buffer;
}

function readChunks(png: Buffer): Chunk[] {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const body = png.subarray(offset + 4, offset + 8 + length);
    expect(png.readUInt32BE(offset + 8 + length)).toBe(crc32(body));
    chunks.push({ type: body.subarray(0, 4).toString('ascii'), data: body.subarray(4) });
    offset += 12 + length;
  }
  return chunks;
}

function pixel(png: Buffer, x: number, y: number): number[] {
  const chunks = readChunks(png);
  const size = chunks[0]?.data.readUInt32BE(0) ?? 0;
  const raw = inflateSync(Buffer.concat(chunks.filter((entry) => entry.type === 'IDAT').map((entry) => entry.data)));
  const offset = y * (1 + size * 4) + 1 + x * 4;
  return [...raw.subarray(offset, offset + 4)];
}

describe('circlePng', () => {
  it('writes a valid RGBA PNG of the requested size', () => {
    const png = circlePng('green', 32);
    const chunks = readChunks(png);
    expect(chunks.map((entry) => entry.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const header = chunks[0]?.data ?? Buffer.alloc(0);
    expect([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9]]).toEqual([32, 32, 8, 6]);
  });

  it('draws an opaque dot in the status colour on a transparent square', () => {
    expect(pixel(circlePng('green', 16), 8, 8)).toEqual([34, 197, 94, 255]);
    expect(pixel(circlePng('red', 16), 7, 7)).toEqual([239, 68, 68, 255]);
    expect(pixel(circlePng('amber', 32), 0, 0)[3]).toBe(0);
    expect(pixel(circlePng('grey', 32), 31, 16)[3]).toBe(0);
  });
});
