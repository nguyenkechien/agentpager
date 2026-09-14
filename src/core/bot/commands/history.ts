import type { CommandContext, Context } from 'grammy';
import type { BotDeps } from '../deps.js';
import { toInlineKeyboard } from '../telegramIo.js';
import { historyView } from '../views.js';

export async function handleHistory(ctx: CommandContext<Context>, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat.id;
  const mode = ctx.match.trim().toLowerCase() === 'all' ? 'all' : 'bot';
  const view = await historyView(mode, chatId, 0, { store: deps.store, source: deps.provider.sessions, now: deps.now });
  await ctx.reply(view.text, { reply_markup: toInlineKeyboard(view.keyboard) });
}
