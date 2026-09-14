import type { Context } from 'grammy';
import type { BotDeps } from '../deps.js';
import { toInlineKeyboard } from '../telegramIo.js';
import { BUSY_TEXT, projectView } from '../views.js';

export async function handleProject(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (deps.manager.isBusy(chatId)) {
    await ctx.reply(BUSY_TEXT);
    return;
  }
  const snapshot = await deps.projects.open();
  const view = projectView(deps.store.getChat(chatId).cwd, snapshot);
  await ctx.reply(view.text, { reply_markup: toInlineKeyboard(view.keyboard) });
}
