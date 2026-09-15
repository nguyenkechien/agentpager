import type { Context } from 'grammy';
import { plural } from '../../../util/time.js';
import type { BotDeps } from '../deps.js';

export async function handleStop(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const result = deps.manager.stop(chatId);
  switch (result.kind) {
    case 'idle':
      await ctx.reply('Nothing is running.');
      return;
    case 'finishing':
      await ctx.reply(`The agent has finished and is sending the result. (dropped ${plural(result.dropped, 'queued message')})`);
      return;
    case 'stopping':
      await ctx.reply(`⏹ Stopping… (dropped ${plural(result.dropped, 'queued message')})`);
      return;
  }
}
