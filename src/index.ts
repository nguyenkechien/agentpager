import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from 'grammy';
import { BOT_COMMANDS, createBot } from './bot/bot.js';
import { ProjectPicker } from './bot/projects.js';
import { TelegramIo } from './bot/telegramIo.js';
import { PromptBroker } from './claude/prompts.js';
import { SdkRunner } from './claude/runner.js';
import { ConfigError, parseConfig, parseGuardRules, type AppConfig } from './config.js';
import { createLogger } from './logger.js';
import { sdkSessionSource } from './sessions/history.js';
import { SessionManager } from './sessions/manager.js';
import { StateStore } from './sessions/store.js';
import { pathExists } from './util/fs.js';
import { acquireLock, LockHeldError } from './util/lock.js';

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_NOTICE_COMMAND_LIMIT = 500;

function loadConfig(): AppConfig {
  const envFile = join(projectDir, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  try {
    return parseConfig(process.env, projectDir);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  // The SDK copies process.env into claude.exe and every command it runs; keep the bot token out of reach.
  delete process.env.TELEGRAM_BOT_TOKEN;
  const logger = createLogger(config.logLevel, join(projectDir, 'logs'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });

  let lock: { release(): Promise<void> };
  try {
    lock = await acquireLock(join(config.dataDir, 'bot.lock'));
  } catch (error) {
    if (error instanceof LockHeldError) {
      logger.fatal({ holderPid: error.pid }, error.message);
      process.exit(1);
    }
    throw error;
  }

  const guardRules = parseGuardRules(readFileSync(join(projectDir, 'guard-rules.json'), 'utf8'));
  const now = (): number => Date.now();
  const { store, quarantinedPath } = await StateStore.open(
    join(config.dataDir, 'state.json'),
    { cwd: config.projectsRoot, model: config.defaultModel, effort: config.defaultEffort },
    now,
    (error) => {
      logger.error({ err: error }, 'failed to write state file');
    },
  );

  const io = new TelegramIo(new Api(config.telegramBotToken), logger);
  const broker = new PromptBroker(io, { timeoutMs: config.idleTimeoutMs, logger });
  const runner = new SdkRunner({
    claudeExecutable: config.claudeExecutable,
    broker,
    fileSender: io,
    guardRules,
    onGuardBlock: (chatId, command, rule) => {
      logger.warn({ chatId, command, rule: rule.id }, 'guard blocked a command');
      const shown = command.length > GUARD_NOTICE_COMMAND_LIMIT ? `${command.slice(0, GUARD_NOTICE_COMMAND_LIMIT)}…` : command;
      io.sendNotice(chatId, `🛡 Đã chặn lệnh: ${shown} — ${rule.reason}`).catch((error: unknown) => {
        logger.error({ err: error, chatId }, 'failed to send guard notice');
      });
    },
    logger,
  });
  const manager = new SessionManager({
    store,
    runner,
    notifier: io,
    broker,
    idleTimeoutMs: config.idleTimeoutMs,
    now,
    logger,
    pathExists,
    fallbackCwd: config.projectsRoot,
  });
  const bot = createBot({
    config,
    manager,
    broker,
    store,
    io,
    source: sdkSessionSource,
    projects: new ProjectPicker(config.projectsRoot),
    logger,
    now,
    pathExists,
  });

  let shadowWarningLogged = false;
  process.on('warning', (warning) => {
    if ((warning as Error & { code?: string }).code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') {
      // Expected with bypassPermissions: only interaction-required calls reach canUseTool.
      if (!shadowWarningLogged) logger.info('canUseTool is shadowed by bypassPermissions as intended');
      shadowWarningLogged = true;
      return;
    }
    logger.warn({ warning: { name: warning.name, message: warning.message } }, 'process warning');
  });

  await bot.api.setMyCommands(BOT_COMMANDS);

  if (quarantinedPath) {
    logger.error({ quarantinedPath }, 'state file was corrupt and has been quarantined');
    for (const userId of config.allowedUserIds) {
      await io.sendNotice(userId, `⚠️ File trạng thái bị hỏng, đã chuyển sang ${quarantinedPath} và bắt đầu lại từ đầu.`);
    }
  }
  await manager.recoverAfterRestart();
  manager.startIdleTimer();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    await bot.stop();
    await manager.shutdown();
    await lock.release();
    logger.info('claude-pager stopped');
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      shutdown(signal).catch((error: unknown) => {
        logger.fatal({ err: error }, 'shutdown failed');
        process.exit(1);
      });
    });
  }

  await bot.start({
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query'],
    onStart: (me) => {
      logger.info({ username: me.username, projectsRoot: config.projectsRoot }, 'claude-pager is polling Telegram');
    },
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
