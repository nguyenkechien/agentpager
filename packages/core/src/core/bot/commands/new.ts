import type { Context } from 'grammy';
import type { BotDeps } from '../deps.js';
import { projectName } from '../format.js';
import { persistState } from '../persist.js';
import { BUSY_TEXT } from '../views.js';

export async function handleNew(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (deps.manager.newSession(chatId) === 'busy') {
    await ctx.reply(BUSY_TEXT);
    return;
  }
  await persistState(deps);
  await ctx.reply(`🆕 Your next message starts a new session in ${projectName(deps.store.getChat(chatId).cwd)}.`);
}
