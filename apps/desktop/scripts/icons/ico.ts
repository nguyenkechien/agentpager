export type IcoEntry =
  | { size: number; format: 'dib'; /** Straight (not premultiplied) RGBA, top row first. */ rgba: Uint8Array }
  | { size: number; format: 'png'; png: Buffer };

/** resvg renders premultiplied RGBA; ICO bitmaps store straight alpha. */
export function unpremultiply(pixels: Uint8Array): Uint8Array {
  const straight = new Uint8Array(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] ?? 0;
    straight[index + 3] = alpha;
    if (alpha === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      straight[index + channel] = Math.min(255, Math.round(((pixels[index + channel] ?? 0) * 255) / alpha));
    }
  }
  return straight;
}

const HEADER_BYTES = 6;
const DIRECTORY_ENTRY_BYTES = 16;
const BITMAP_INFO_HEADER_BYTES = 40;

/** 32-bit DIB as stored in an ICO: BITMAPINFOHEADER, bottom-up BGRA rows, then an all-zero AND mask. */
function dibImage(size: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== size * size * 4) throw new Error(`expected ${size * size * 4} RGBA bytes for ${size}px, got ${rgba.length}`);
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const pixelBytes = size * size * 4;
  const image = Buffer.alloc(BITMAP_INFO_HEADER_BYTES + pixelBytes + maskRowBytes * size);
  image.writeUInt32LE(BITMAP_INFO_HEADER_BYTES, 0);
  image.writeInt32LE(size, 4);
  // The height counts the colour bitmap and the AND mask.
  image.writeInt32LE(size * 2, 8);
  image.writeUInt16LE(1, 12);
  image.writeUInt16LE(32, 14);
  image.writeUInt32LE(0, 16);
  image.writeUInt32LE(pixelBytes + maskRowBytes * size, 20);
  for (let y = 0; y < size; y += 1) {
    const sourceRow = (size - 1 - y) * size * 4;
    const targetRow = BITMAP_INFO_HEADER_BYTES + y * size * 4;
    for (let x = 0; x < size; x += 1) {
      const source = sourceRow + x * 4;
      const target = targetRow + x * 4;
      image[target] = rgba[source + 2] ?? 0;
      image[target + 1] = rgba[source + 1] ?? 0;
      image[target + 2] = rgba[source] ?? 0;
      image[target + 3] = rgba[source + 3] ?? 0;
    }
  }
  return image;
}

/** A Windows .ico holding every entry in order. */
export function buildIco(entries: readonly IcoEntry[]): Buffer {
  const images = entries.map((entry) => {
    if (entry.size < 1 || entry.size > 256) throw new Error(`icon size ${entry.size} is outside 1–256`);
    return entry.format === 'dib' ? dibImage(entry.size, entry.rgba) : entry.png;
  });
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(DIRECTORY_ENTRY_BYTES * entries.length);
  let offset = HEADER_BYTES + directory.length;
  entries.forEach((entry, index) => {
    const image = images[index] ?? Buffer.alloc(0);
    const at = index * DIRECTORY_ENTRY_BYTES;
    // Width and height bytes use 0 for 256.
    directory[at] = entry.size === 256 ? 0 : entry.size;
    directory[at + 1] = entry.size === 256 ? 0 : entry.size;
    directory[at + 2] = 0;
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(image.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  return Buffer.concat([header, directory, ...images]);
}

export interface IcoDirectoryEntry {
  size: number;
  bitCount: number;
  bytes: number;
  offset: number;
}

/** Reads the directory of an .ico (used to check generated icons). */
export function readIcoDirectory(ico: Buffer): IcoDirectoryEntry[] {
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('not an .ico file');
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_unused, index) => {
    const at = HEADER_BYTES + index * DIRECTORY_ENTRY_BYTES;
    return {
      size: ico[at] === 0 ? 256 : (ico[at] ?? 0),
      bitCount: ico.readUInt16LE(at + 6),
      bytes: ico.readUInt32LE(at + 8),
      offset: ico.readUInt32LE(at + 12),
    };
  });
}
