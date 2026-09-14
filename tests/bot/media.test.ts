import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadTelegramFile, FileTooLargeError, safeFileName, uploadDir } from '../../src/bot/media.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeApi(file: { file_id: string; file_unique_id: string; file_size?: number; file_path?: string }) {
  return { getFile: vi.fn(() => Promise.resolve(file)) };
}

describe('safeFileName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['my file (1).txt', 'my_file_1_.txt'],
    ['..\\..\\evil.exe', 'evil.exe'],
    ['', 'file'],
    ['ảnh chụp.jpg', '_nh_ch_p.jpg'],
  ])('%j → %j', (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });
});

describe('uploadDir', () => {
  it('groups uploads by local date', () => {
    expect(uploadDir('D:\\data', new Date(2026, 8, 4))).toBe(join('D:\\data', 'uploads', '20260904'));
  });
});

describe('downloadTelegramFile', () => {
  it('downloads the file into the destination directory', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('hello file')));
    vi.stubGlobal('fetch', fetchMock);
    const dir = join(mkdtempSync(join(tmpdir(), 'pager-media-')), 'nested');

    const path = await downloadTelegramFile(
      fakeApi({ file_id: 'f', file_unique_id: 'u', file_size: 10, file_path: 'documents/file_1.txt' }),
      'TOKEN',
      'f',
      dir,
      'notes.txt',
      () => 123,
    );

    expect(fetchMock).toHaveBeenCalledWith('https://api.telegram.org/file/botTOKEN/documents/file_1.txt');
    expect(path).toBe(join(dir, '123-notes.txt'));
    expect(readFileSync(path, 'utf8')).toBe('hello file');
  });

  it('refuses files over 20 MB before downloading', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      downloadTelegramFile(fakeApi({ file_id: 'f', file_unique_id: 'u', file_size: 21 * 1024 * 1024 }), 'T', 'f', tmpdir(), 'x'),
    ).rejects.toBeInstanceOf(FileTooLargeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 404 }))));
    await expect(
      downloadTelegramFile(fakeApi({ file_id: 'f', file_unique_id: 'u', file_path: 'a/b' }), 'T', 'f', tmpdir(), 'x'),
    ).rejects.toThrow('HTTP 404');
  });
});
