import { describe, expect, it, vi } from 'vitest';
import { photoTurnInput } from '../../../src/core/bot/handlers/media.js';

const PATH = 'D:\\data\\uploads\\photo.jpg';

describe('photoTurnInput', () => {
  it('sends image bytes to providers with native image input', async () => {
    const read = vi.fn(() => Promise.resolve(Buffer.from('img')));
    await expect(photoTurnInput('native', PATH, 'look', read)).resolves.toEqual({
      kind: 'photo',
      imageBase64: Buffer.from('img').toString('base64'),
      mediaType: 'image/jpeg',
      imagePath: PATH,
      text: `look\n\nPhoto saved at ${PATH}`,
    });
    expect(read).toHaveBeenCalledWith(PATH);
  });

  it('sends only the saved path to providers without image input', async () => {
    const read = vi.fn(() => Promise.resolve(Buffer.from('img')));
    await expect(photoTurnInput('path', PATH, undefined, read)).resolves.toEqual({
      kind: 'text',
      text: `(no caption)\n\nPhoto saved at ${PATH}`,
    });
    expect(read).not.toHaveBeenCalled();
  });
});
