import { Bot } from 'grammy';
import { createAuthMiddleware } from './auth.js';
import { handleHistory } from './commands/history.js';
import { handleModel } from './commands/model.js';
import { handleNew } from './commands/new.js';
import { handleProject } from './commands/project.js';
import { handleResume } from './commands/resume.js';
import { handleStart } from './commands/start.js';
import { handleStatus } from './commands/status.js';
import { handleStop } from './commands/stop.js';
import type { BotDeps } from './deps.js';
import { handleCallback } from './handlers/callbacks.js';
import { handleDocument, handlePhoto } from './handlers/media.js';
import { handleTextMessage } from './handlers/message.js';

export const BOT_COMMANDS: readonly { command: string; description: string }[] = [
  { command: 'new', description: 'Mở phiên mới' },
  { command: 'history', description: 'Session cũ (/history all: mọi session của project)' },
  { command: 'resume', description: 'Vào lại session cũ' },
  { command: 'project', description: 'Chọn project' },
  { command: 'stop', description: 'Dừng lượt đang chạy' },
  { command: 'status', description: 'Trạng thái hiện tại' },
  { command: 'model', description: 'Đổi model / effort' },
  { command: 'help', description: 'Hướng dẫn' },
];

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.config.telegramBotToken);

  bot.use(createAuthMiddleware(deps.config.allowedUserIds, deps.logger));

  bot.command(['start', 'help'], (ctx) => handleStart(ctx, deps));
  bot.command('new', (ctx) => handleNew(ctx, deps));
  bot.command('history', (ctx) => handleHistory(ctx, deps));
  bot.command('resume', (ctx) => handleResume(ctx, deps));
  bot.command('project', (ctx) => handleProject(ctx, deps));
  bot.command('stop', (ctx) => handleStop(ctx, deps));
  bot.command('status', (ctx) => handleStatus(ctx, deps));
  bot.command('model', (ctx) => handleModel(ctx, deps));

  bot.on('callback_query:data', (ctx) => handleCallback(ctx, deps));
  bot.on('message:photo', (ctx) => handlePhoto(ctx, deps));
  bot.on('message:document', (ctx) => handleDocument(ctx, deps));
  bot.on('message:text', (ctx) => handleTextMessage(ctx, deps));

  bot.catch((error) => {
    deps.logger.error({ err: error.error, updateId: error.ctx.update.update_id }, 'unhandled bot error');
  });

  return bot;
}
