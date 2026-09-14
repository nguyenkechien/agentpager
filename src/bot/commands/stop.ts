import type { Context } from 'grammy';
import type { BotDeps } from '../deps.js';

export async function handleStop(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const result = await deps.manager.stop(chatId);
  if (result.kind === 'idle') {
    await ctx.reply('Không có gì đang chạy.');
    return;
  }
  await ctx.reply(`⏹ Đang dừng… (bỏ ${result.dropped} tin trong hàng đợi)`);
}
