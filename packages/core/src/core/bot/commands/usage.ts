import type { Context } from 'grammy';
import type { BotDeps } from '../deps.js';
import { usageText } from '../format.js';
import { NO_USAGE_TEXT } from '../views.js';

export async function handleUsage(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const { provider } = deps;
  if (!provider.fetchUsage) {
    await ctx.reply(NO_USAGE_TEXT);
    return;
  }
  await ctx.reply('⏳ Fetching usage…');

  // Runs in the background: grammY handles updates one at a time and the lookup takes a few seconds.
  void provider
    .fetchUsage()
    .then(
      (report) => deps.io.sendNotice(chatId, usageText(report, deps.now())),
      (error: unknown) => {
        deps.logger.warn({ err: error, chatId }, 'usage lookup failed');
        return deps.io.sendNotice(chatId, `❌ Could not fetch usage: ${error instanceof Error ? error.message : String(error)}`);
      },
    )
    .catch((error: unknown) => {
      deps.logger.error({ err: error, chatId }, 'failed to send usage reply');
    });
}
