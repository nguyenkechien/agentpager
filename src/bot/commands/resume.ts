import type { CommandContext, Context } from 'grammy';
import type { BotDeps } from '../deps.js';
import { toInlineKeyboard } from '../telegramIo.js';
import { historyView, resumeReply } from '../views.js';

export async function handleResume(ctx: CommandContext<Context>, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat.id;
  const arg = ctx.match.trim();
  if (arg === '') {
    const view = await historyView('bot', chatId, 0, deps);
    await ctx.reply(view.text, { reply_markup: toInlineKeyboard(view.keyboard) });
    return;
  }
  const reply = await resumeReply(arg, chatId, deps);
  await deps.store.flush();
  await ctx.reply(reply);
}
