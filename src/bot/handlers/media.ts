import { readFile } from 'node:fs/promises';
import type { Context, Filter } from 'grammy';
import type { TurnInput } from '../../claude/runner.js';
import type { BotDeps } from '../deps.js';
import { downloadTelegramFile, FileTooLargeError, MAX_DOWNLOAD_BYTES, uploadDir } from '../media.js';
import { submitReply } from '../views.js';

const TOO_LARGE_TEXT = 'File quá 20MB, Telegram Bot API không tải được.';
const NO_CAPTION = '(không có caption)';

async function submitInput(ctx: Context, deps: BotDeps, chatId: number, input: TurnInput, title: string): Promise<void> {
  const reply = submitReply(await deps.manager.submit(chatId, input, title));
  if (reply) await ctx.reply(reply);
}

async function download(
  ctx: Context,
  deps: BotDeps,
  fileId: string,
  fileSize: number | undefined,
  fileName: string,
): Promise<string | null> {
  if (fileSize !== undefined && fileSize > MAX_DOWNLOAD_BYTES) {
    await ctx.reply(TOO_LARGE_TEXT);
    return null;
  }
  try {
    return await downloadTelegramFile(
      ctx.api,
      deps.config.telegramBotToken,
      fileId,
      uploadDir(deps.config.dataDir, new Date(deps.now())),
      fileName,
      deps.now,
    );
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      await ctx.reply(TOO_LARGE_TEXT);
      return null;
    }
    deps.logger.error({ err: error, fileId }, 'failed to download Telegram file');
    await ctx.reply(`❌ Không tải được file: ${(error as Error).message}`);
    return null;
  }
}

export async function handlePhoto(ctx: Filter<Context, 'message:photo'>, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat.id;
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;

  const path = await download(ctx, deps, photo.file_id, photo.file_size, 'photo.jpg');
  if (!path) return;

  const caption = ctx.message.caption ?? NO_CAPTION;
  const imageBase64 = (await readFile(path)).toString('base64');
  await submitInput(
    ctx,
    deps,
    chatId,
    { kind: 'photo', imageBase64, mediaType: 'image/jpeg', text: `${caption}\n\nẢnh đã lưu tại ${path}` },
    ctx.message.caption ?? '(ảnh)',
  );
}

export async function handleDocument(ctx: Filter<Context, 'message:document'>, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat.id;
  const document = ctx.message.document;
  const fileName = document.file_name ?? 'file';

  const path = await download(ctx, deps, document.file_id, document.file_size, fileName);
  if (!path) return;

  const caption = ctx.message.caption ?? NO_CAPTION;
  await submitInput(
    ctx,
    deps,
    chatId,
    { kind: 'text', text: `${caption}\n\nFile đính kèm đã lưu tại ${path}` },
    ctx.message.caption ?? fileName,
  );
}
