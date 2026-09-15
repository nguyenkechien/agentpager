import { readFile } from 'node:fs/promises';
import type { Context, Filter } from 'grammy';
import type { ProviderCapabilities, TurnInput } from '../../../providers/types.js';
import type { BotDeps } from '../deps.js';
import { downloadTelegramFile, FileTooLargeError, MAX_DOWNLOAD_BYTES, uploadDir } from '../media.js';
import { submitReply } from '../views.js';

const TOO_LARGE_TEXT = 'The file is over 20MB; the Telegram Bot API cannot download it.';
const NO_CAPTION = '(no caption)';

async function submitInput(ctx: Context, deps: BotDeps, chatId: number, input: TurnInput, title: string): Promise<void> {
  const reply = submitReply(await deps.manager.submit(chatId, input, title), deps.now());
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
      deps.settings.botToken,
      fileId,
      uploadDir(deps.settings.uploadsDir, new Date(deps.now())),
      fileName,
      deps.now,
    );
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      await ctx.reply(TOO_LARGE_TEXT);
      return null;
    }
    deps.logger.error({ err: error, fileId }, 'failed to download Telegram file');
    await ctx.reply(`❌ Could not download the file: ${(error as Error).message}`);
    return null;
  }
}

/** Providers without native image input get the saved file path in the prompt instead of the image bytes. */
export async function photoTurnInput(
  imageInput: ProviderCapabilities['imageInput'],
  path: string,
  caption: string | undefined,
  read: (path: string) => Promise<Buffer> = (file) => readFile(file),
): Promise<TurnInput> {
  const text = `${caption ?? NO_CAPTION}\n\nPhoto saved at ${path}`;
  if (imageInput === 'path') return { kind: 'text', text };
  const imageBase64 = (await read(path)).toString('base64');
  return { kind: 'photo', imageBase64, mediaType: 'image/jpeg', imagePath: path, text };
}

export async function handlePhoto(ctx: Filter<Context, 'message:photo'>, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat.id;
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;

  const path = await download(ctx, deps, photo.file_id, photo.file_size, 'photo.jpg');
  if (!path) return;

  const input = await photoTurnInput(deps.provider.capabilities.imageInput, path, ctx.message.caption);
  await submitInput(ctx, deps, chatId, input, ctx.message.caption ?? '(photo)');
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
    { kind: 'text', text: `${caption}\n\nAttached file saved at ${path}` },
    ctx.message.caption ?? fileName,
  );
}
