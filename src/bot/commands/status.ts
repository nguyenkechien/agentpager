import type { Context } from 'grammy';
import type { BotDeps } from '../deps.js';
import { statusText } from '../format.js';

export async function handleStatus(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  await ctx.reply(statusText(deps.manager.status(chatId), deps.now()));
}
