import type { CommandContext, Context } from 'grammy';
import type { BotDeps } from '../deps.js';
import { persistState } from '../persist.js';
import { toInlineKeyboard } from '../telegramIo.js';
import { historyView, resumeReply } from '../views.js';

export async function handleResume(ctx: CommandContext<Context>, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat.id;
  const arg = ctx.match.trim();
  if (arg === '') {
    const view = await historyView('bot', chatId, 0, { store: deps.store, source: deps.provider.sessions, now: deps.now });
    await ctx.reply(view.text, { reply_markup: toInlineKeyboard(view.keyboard) });
    return;
  }
  const reply = await resumeReply(arg, chatId, {
    store: deps.store,
    source: deps.provider.sessions,
    manager: deps.manager,
    pathExists: deps.pathExists,
  });
  await persistState(deps);
  await ctx.reply(reply);
}
