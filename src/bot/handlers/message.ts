import type { Context, Filter } from 'grammy';
import type { BotDeps } from '../deps.js';
import { submitReply } from '../views.js';

export async function handleTextMessage(ctx: Filter<Context, 'message:text'>, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  if (await deps.broker.consumeText(chatId, text)) return;

  const reply = submitReply(await deps.manager.submit(chatId, { kind: 'text', text }, text), deps.now());
  if (reply) await ctx.reply(reply);
}
