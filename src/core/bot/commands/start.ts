import type { Context } from 'grammy';
import type { BotDeps } from '../deps.js';
import { helpText } from '../views.js';

export async function handleStart(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const idleMinutes = Math.round(deps.config.idleTimeoutMs / 60_000);
  await ctx.reply(helpText(deps.store.getChat(chatId).cwd, idleMinutes, deps.provider));
}
