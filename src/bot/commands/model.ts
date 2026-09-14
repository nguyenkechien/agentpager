import type { Context } from 'grammy';
import type { BotDeps } from '../deps.js';
import { toInlineKeyboard } from '../telegramIo.js';
import { modelView } from '../views.js';

export async function handleModel(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const chat = deps.store.getChat(chatId);
  const view = modelView(chat.model, chat.effort);
  await ctx.reply(view.text, { reply_markup: toInlineKeyboard(view.keyboard) });
}
