import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Api } from 'grammy';

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super(`File is ${sizeBytes} bytes; the Telegram Bot API only allows downloads up to 20 MB`);
    this.name = 'FileTooLargeError';
  }
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-100);
  return cleaned || 'file';
}

export function uploadDir(dataDir: string, date: Date): string {
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return join(dataDir, 'uploads', stamp);
}

export async function downloadTelegramFile(
  api: Pick<Api, 'getFile'>,
  token: string,
  fileId: string,
  destDir: string,
  fileName: string,
  now: () => number = Date.now,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (file.file_size !== undefined && file.file_size > MAX_DOWNLOAD_BYTES) throw new FileTooLargeError(file.file_size);
  if (!file.file_path) throw new Error('Telegram did not return a file path for the download');

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok || !response.body) throw new Error(`Telegram file download failed: HTTP ${response.status}`);

  await mkdir(destDir, { recursive: true });
  const destination = join(destDir, `${now()}-${safeFileName(fileName)}`);
  await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(destination));
  return destination;
}
