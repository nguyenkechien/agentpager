import type { Context } from 'grammy';
import type { BotDeps } from '../deps.js';

export async function handleStop(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const result = deps.manager.stop(chatId);
  switch (result.kind) {
    case 'idle':
      await ctx.reply('Không có gì đang chạy.');
      return;
    case 'finishing':
      await ctx.reply(`Agent đã trả lời xong, đang gửi kết quả. (bỏ ${result.dropped} tin trong hàng đợi)`);
      return;
    case 'stopping':
      await ctx.reply(`⏹ Đang dừng… (bỏ ${result.dropped} tin trong hàng đợi)`);
      return;
  }
}
