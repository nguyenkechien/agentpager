import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSendFileMcpServer, deliverFile } from '../../../src/providers/claude-code/sendFileTool.js';
import type { FileSender } from '../../../src/providers/types.js';

class FakeSender implements FileSender {
  photos: { chatId: number; filePath: string; caption: string | undefined }[] = [];
  documents: { chatId: number; filePath: string; caption: string | undefined }[] = [];
  failure: Error | null = null;

  sendPhoto(chatId: number, filePath: string, caption: string | undefined): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.photos.push({ chatId, filePath, caption });
    return Promise.resolve();
  }

  sendDocument(chatId: number, filePath: string, caption: string | undefined): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.documents.push({ chatId, filePath, caption });
    return Promise.resolve();
  }
}

let cwd: string;
let sender: FakeSender;

function makeFile(name: string, bytes: number): string {
  const filePath = join(cwd, name);
  writeFileSync(filePath, '');
  truncateSync(filePath, bytes);
  return filePath;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pager-tools-'));
  sender = new FakeSender();
});

describe('deliverFile', () => {
  it('resolves relative paths against the session cwd and sends small images as photos', async () => {
    const filePath = makeFile('shot.png', 1024);
    await expect(deliverFile(sender, 7, cwd, 'shot.png', 'look')).resolves.toEqual({
      ok: true,
      kind: 'photo',
      path: filePath,
    });
    expect(sender.photos).toEqual([{ chatId: 7, filePath, caption: 'look' }]);
  });

  it('keeps absolute paths and sends other files as documents', async () => {
    const filePath = makeFile('log.txt', 10);
    await expect(deliverFile(sender, 7, 'D:\\elsewhere', filePath)).resolves.toMatchObject({
      ok: true,
      kind: 'document',
    });
    expect(sender.documents).toEqual([{ chatId: 7, filePath, caption: undefined }]);
  });

  it('sends large images as documents', async () => {
    makeFile('big.jpg', 11 * 1024 * 1024);
    await expect(deliverFile(sender, 7, cwd, 'big.jpg')).resolves.toMatchObject({ ok: true, kind: 'document' });
  });

  it('rejects missing files, directories and files over 50 MB', async () => {
    mkdirSync(join(cwd, 'folder'));
    makeFile('huge.zip', 51 * 1024 * 1024);
    await expect(deliverFile(sender, 7, cwd, 'missing.txt')).resolves.toMatchObject({ ok: false });
    await expect(deliverFile(sender, 7, cwd, 'folder')).resolves.toMatchObject({ ok: false });
    const huge = await deliverFile(sender, 7, cwd, 'huge.zip');
    expect(huge).toMatchObject({ ok: false });
    expect(huge.ok ? '' : huge.error).toMatch(/50 MB/);
    expect(sender.documents).toEqual([]);
  });

  it('reports upload failures', async () => {
    makeFile('a.txt', 1);
    sender.failure = new Error('network down');
    await expect(deliverFile(sender, 7, cwd, 'a.txt')).resolves.toEqual({
      ok: false,
      error: 'Telegram upload failed: network down',
    });
  });
});

describe('createSendFileMcpServer', () => {
  it('creates an in-process server named telegram', () => {
    const server = createSendFileMcpServer(sender, 7, cwd);
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('telegram');
  });
});
