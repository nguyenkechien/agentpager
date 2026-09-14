import { GrammyError, type Context, type Filter } from 'grammy';

type CallbackContext = Filter<Context, 'callback_query:data'>;
import { EFFORTS, MODEL_ALIASES, type Effort, type ModelAlias } from '../../config.js';
import type { BotDeps } from '../deps.js';
import { persistState } from '../persist.js';
import { toInlineKeyboard } from '../telegramIo.js';
import { BUSY_TEXT, historyView, modelView, resumeReply, STALE_BUTTON_TEXT, type View } from '../views.js';

async function editView(ctx: Context, view: View, deps: BotDeps): Promise<void> {
  try {
    await ctx.editMessageText(view.text, { reply_markup: toInlineKeyboard(view.keyboard) });
  } catch (error) {
    // Re-selecting the current option produces identical content, which Telegram rejects; nothing to update.
    if (error instanceof GrammyError && /message is not modified/i.test(error.description)) {
      deps.logger.debug('callback edit skipped: message not modified');
      return;
    }
    throw error;
  }
}

async function handleHistoryPage(ctx: Context, deps: BotDeps, chatId: number, parts: string[]): Promise<string | null> {
  const [, modeKey, pageText] = parts;
  if ((modeKey !== 'b' && modeKey !== 'a') || !/^\d+$/.test(pageText ?? '')) return STALE_BUTTON_TEXT;
  await editView(ctx, await historyView(modeKey === 'b' ? 'bot' : 'all', chatId, Number(pageText), deps), deps);
  return null;
}

async function handleProjectChoice(ctx: Context, deps: BotDeps, chatId: number, parts: string[]): Promise<string | null> {
  const [, snapshotId, indexText] = parts;
  const dir = snapshotId && /^\d+$/.test(indexText ?? '') ? deps.projects.resolve(snapshotId, Number(indexText)) : null;
  if (!dir) return 'Danh sách đã cũ, gõ /project lại';
  if (!(await deps.pathExists(dir))) return `Thư mục không còn tồn tại: ${dir}`;

  const result = deps.manager.setProject(chatId, dir);
  if (result === 'busy') return BUSY_TEXT;
  await persistState(deps);
  const text =
    result === 'unchanged' ? `📁 Vẫn ở ${dir}` : `📁 Đã chuyển sang ${dir}. Tin nhắn tiếp theo sẽ mở phiên mới.`;
  await editView(ctx, { text, keyboard: [] }, deps);
  return null;
}

async function handleModelChoice(ctx: Context, deps: BotDeps, chatId: number, kind: 'm' | 'e', value: string): Promise<string | null> {
  if (kind === 'm') {
    if (value !== 'default' && !(MODEL_ALIASES as readonly string[]).includes(value)) return STALE_BUTTON_TEXT;
    deps.manager.setModel(chatId, value === 'default' ? null : (value as ModelAlias));
  } else {
    if (value !== 'default' && !(EFFORTS as readonly string[]).includes(value)) return STALE_BUTTON_TEXT;
    deps.manager.setEffort(chatId, value === 'default' ? null : (value as Effort));
  }
  await persistState(deps);
  const chat = deps.store.getChat(chatId);
  await editView(ctx, modelView(chat.model, chat.effort), deps);
  return null;
}

async function route(ctx: CallbackContext, deps: BotDeps, chatId: number, data: string): Promise<string | null> {
  const parts = data.split(':');
  switch (parts[0]) {
    case 'q':
    case 'a':
      return (await deps.broker.handleCallback(chatId, data)).alert;
    case 'h':
      return handleHistoryPage(ctx, deps, chatId, parts);
    case 'r': {
      const sessionId = data.slice(2);
      const reply = await resumeReply(sessionId, chatId, deps);
      await persistState(deps);
      await ctx.reply(reply);
      return null;
    }
    case 'p':
      return handleProjectChoice(ctx, deps, chatId, parts);
    case 'm':
    case 'e':
      return handleModelChoice(ctx, deps, chatId, parts[0], parts.slice(1).join(':'));
    default:
      return STALE_BUTTON_TEXT;
  }
}

export async function handleCallback(ctx: CallbackContext, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    await ctx.answerCallbackQuery({ text: STALE_BUTTON_TEXT });
    return;
  }
  let alert: string | null;
  try {
    alert = await route(ctx, deps, chatId, ctx.callbackQuery.data);
  } catch (error) {
    deps.logger.error({ err: error, chatId, data: ctx.callbackQuery.data }, 'callback handling failed');
    await ctx.answerCallbackQuery({ text: `❌ Lỗi: ${(error as Error).message}`.slice(0, 200) });
    return;
  }
  await ctx.answerCallbackQuery(alert ? { text: alert } : {});
}
