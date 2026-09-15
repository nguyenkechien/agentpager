import { describe, expect, it } from 'vitest';
import { buildIco, readIcoDirectory, unpremultiply } from '../../../scripts/icons/ico.js';

describe('unpremultiply', () => {
  it('turns premultiplied colour back into straight colour and keeps transparent pixels black', () => {
    // resvg renders #ff8000 at 50% opacity as [128, 64, 0, 128].
    expect([...unpremultiply(new Uint8Array([128, 64, 0, 128, 0, 0, 0, 0, 20, 20, 20, 255]))]).toEqual([
      255, 128, 0, 128, 0, 0, 0, 0, 20, 20, 20, 255,
    ]);
  });
});

/** 2×2 RGBA: red, green on the top row; blue, half-transparent white on the bottom row. */
const PIXELS = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('buildIco', () => {
  it('writes the header and a directory entry per image with consistent offsets', () => {
    const ico = buildIco([
      { size: 2, format: 'dib', rgba: PIXELS },
      { size: 256, format: 'png', png: PNG },
    ]);
    expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 2, 0]);
    const directory = readIcoDirectory(ico);
    expect(directory.map((entry) => entry.size)).toEqual([2, 256]);
    expect(directory.map((entry) => entry.bitCount)).toEqual([32, 32]);
    expect(directory[0]?.offset).toBe(6 + 32);
    expect(directory[1]?.offset).toBe((directory[0]?.offset ?? 0) + (directory[0]?.bytes ?? 0));
    expect((directory[1]?.offset ?? 0) + (directory[1]?.bytes ?? 0)).toBe(ico.length);
    // 256 is stored as 0 in the width and height bytes.
    expect([ico[6 + 16], ico[6 + 17]]).toEqual([0, 0]);
  });

  it('stores small images as bottom-up BGRA with a doubled height and a padded AND mask', () => {
    const ico = buildIco([{ size: 2, format: 'dib', rgba: PIXELS }]);
    const [entry] = readIcoDirectory(ico);
    const image = ico.subarray(entry?.offset ?? 0, (entry?.offset ?? 0) + (entry?.bytes ?? 0));
    expect(image.readUInt32LE(0)).toBe(40);
    expect([image.readInt32LE(4), image.readInt32LE(8), image.readUInt16LE(12), image.readUInt16LE(14)]).toEqual([2, 4, 1, 32]);
    // First stored row is the bottom image row: blue, then half-transparent white.
    expect([...image.subarray(40, 48)]).toEqual([255, 0, 0, 255, 255, 255, 255, 128]);
    expect([...image.subarray(48, 56)]).toEqual([0, 0, 255, 255, 0, 255, 0, 255]);
    // AND mask: 2 rows of 4 bytes (32-bit padding), all zero.
    expect(image.length).toBe(40 + 16 + 8);
    expect([...image.subarray(56)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('stores PNG entries unchanged', () => {
    const ico = buildIco([{ size: 128, format: 'png', png: PNG }]);
    const [entry] = readIcoDirectory(ico);
    expect(ico.subarray(entry?.offset ?? 0)).toEqual(PNG);
  });

  it('rejects pixel data of the wrong length and impossible sizes', () => {
    expect(() => buildIco([{ size: 3, format: 'dib', rgba: PIXELS }])).toThrow('expected 36 RGBA bytes');
    expect(() => buildIco([{ size: 300, format: 'png', png: PNG }])).toThrow('outside 1–256');
  });
});
