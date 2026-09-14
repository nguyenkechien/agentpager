import { stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface FileSender {
  sendPhoto(chatId: number, filePath: string, caption: string | undefined): Promise<void>;
  sendDocument(chatId: number, filePath: string, caption: string | undefined): Promise<void>;
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export type DeliveryResult =
  | { ok: true; kind: 'photo' | 'document'; path: string }
  | { ok: false; error: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function deliverFile(
  sender: FileSender,
  chatId: number,
  cwd: string,
  rawPath: string,
  caption?: string,
): Promise<DeliveryResult> {
  const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { ok: false, error: `Not a file: ${filePath}` };
    size = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: `File not found: ${filePath}` };
    return { ok: false, error: `Cannot read ${filePath}: ${messageOf(error)}` };
  }

  if (size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `File is larger than 50 MB, the Telegram Bot API upload limit: ${filePath}` };
  }

  const kind = PHOTO_EXTENSIONS.has(extname(filePath).toLowerCase()) && size <= MAX_PHOTO_BYTES ? 'photo' : 'document';
  try {
    if (kind === 'photo') await sender.sendPhoto(chatId, filePath, caption);
    else await sender.sendDocument(chatId, filePath, caption);
  } catch (error) {
    return { ok: false, error: `Telegram upload failed: ${messageOf(error)}` };
  }
  return { ok: true, kind, path: filePath };
}

export function createTelegramMcpServer(sender: FileSender, chatId: number, cwd: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'telegram',
    version: '1.0.0',
    tools: [
      tool(
        'send_file',
        'Send a file from this machine to the user in Telegram (screenshots, logs, diffs, generated files). ' +
          'Images up to 10 MB are shown inline; other files are sent as documents; maximum 50 MB.',
        {
          path: z.string().min(1).describe('Absolute path, or a path relative to the session working directory'),
          caption: z.string().max(1024).optional().describe('Optional caption shown under the file'),
        },
        async (args) => {
          const result = await deliverFile(sender, chatId, cwd, args.path, args.caption);
          if (result.ok) return { content: [{ type: 'text', text: `sent ${result.kind}: ${result.path}` }] };
          return { content: [{ type: 'text', text: result.error }], isError: true };
        },
      ),
    ],
  });
}
