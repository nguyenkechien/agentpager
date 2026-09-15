import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Api } from 'grammy';
import type { Logger } from 'pino';
import { createLogger } from '../logger.js';
import type { AppPaths, PlatformInfo } from '../platform/paths.js';
import { createProvider as createRegistryProvider, providerCatalog } from '../providers/registry.js';
import type { ProviderCatalogEntry } from '../providers/types.js';
import { pathExists } from '../util/fs.js';
import { acquireLock } from '../util/lock.js';
import { BOT_COMMANDS, createBot as createTelegramBot } from './bot/bot.js';
import { ProjectPicker } from './bot/projects.js';
import { TelegramIo } from './bot/telegramIo.js';
import { AllowedUsersRegistry } from './config/allowedUsers.js';
import type { AgentpagerConfig } from './config/schema.js';
import { ConfigStore } from './config/store.js';
import { createGuardPolicy, parseGuardRules } from './guard/policy.js';
import { PromptBroker } from './prompts/broker.js';
import { LimitTracker } from './sessions/limits.js';
import { SessionManager, type SessionActivity } from './sessions/manager.js';
import { StateStore } from './sessions/store.js';
import { buildSystemPrompt } from './systemPrompt.js';

export const DEFAULT_GUARD_RULES_FILE = 'guard-rules.default.json';
const GUARD_NOTICE_COMMAND_LIMIT = 500;

export interface WorkerHandle {
  botUsername: string;
  provider: string;
  /** Settles when Telegram polling ends: resolves after shutdown, rejects when polling fails. */
  done: Promise<void>;
  shutdown(): Promise<void>;
  reloadUsers(): Promise<void>;
}

export interface WorkerDeps {
  paths: AppPaths;
  platform: PlatformInfo;
  /** Folder holding guard-rules.default.json (the installed package root). */
  packageRoot: string;
  createBot?: typeof createTelegramBot;
  createProvider?: typeof createRegistryProvider;
  catalog?: readonly ProviderCatalogEntry[];
  logger?: Logger;
  now?: () => number;
  /** Receives the session manager's activity changes (the worker forwards them to the supervisor). */
  onActivity?: (activity: SessionActivity) => void;
}

async function loadGuardRulesText(paths: AppPaths, packageRoot: string): Promise<string> {
  const file = (await pathExists(paths.guardRules)) ? paths.guardRules : join(packageRoot, DEFAULT_GUARD_RULES_FILE);
  return readFile(file, 'utf8');
}

async function run(
  deps: WorkerDeps,
  config: AgentpagerConfig,
  configStore: ConfigStore,
  catalog: readonly ProviderCatalogEntry[],
  logger: Logger,
  lock: { release(): Promise<void> },
): Promise<WorkerHandle> {
  const { paths } = deps;
  const now = deps.now ?? Date.now;
  const guardRules = parseGuardRules(await loadGuardRulesText(paths, deps.packageRoot));
  const catalogEntry = catalog.find((entry) => entry.id === config.agent.provider);
  if (!catalogEntry) throw new Error(`Unknown agent provider "${config.agent.provider}"`);

  const { store, quarantinedPath } = await StateStore.open(
    paths.state,
    { cwd: config.projectsRoot, model: config.agent.defaultModel, effort: config.agent.defaultEffort },
    now,
    (error) => {
      logger.error({ err: error }, 'failed to write state file');
    },
  );

  const idleTimeoutMs = config.idleTimeoutMinutes * 60_000;
  const io = new TelegramIo(new Api(config.telegram.botToken), logger);
  const broker = new PromptBroker(io, { timeoutMs: idleTimeoutMs, logger });
  const guard = createGuardPolicy(guardRules, (chatId, command, rule) => {
    logger.warn({ chatId, command, rule: rule.id }, 'guard blocked a command');
    const shown = command.length > GUARD_NOTICE_COMMAND_LIMIT ? `${command.slice(0, GUARD_NOTICE_COMMAND_LIMIT)}…` : command;
    io.sendNotice(chatId, `🛡 Đã chặn lệnh: ${shown} — ${rule.reason}`).catch((error: unknown) => {
      logger.error({ err: error, chatId }, 'failed to send guard notice');
    });
  });
  const provider = (deps.createProvider ?? createRegistryProvider)(
    config.agent.provider,
    { executable: config.agent.executable },
    { guard, fileSender: io, prompts: broker, systemPrompt: buildSystemPrompt(catalogEntry.capabilities), logger },
  );
  const limits = new LimitTracker({ store, notifier: io, fetchUsage: provider.fetchUsage ?? null, now, logger });
  const manager = new SessionManager({
    store,
    provider,
    notifier: io,
    broker,
    limits,
    idleTimeoutMs,
    now,
    logger,
    pathExists,
    fallbackCwd: config.projectsRoot,
    onActivity: deps.onActivity,
  });
  const users = new AllowedUsersRegistry(configStore, () => new Date(now()));
  await users.load();

  const bot = (deps.createBot ?? createTelegramBot)({
    settings: { botToken: config.telegram.botToken, uploadsDir: paths.uploads, idleTimeoutMs },
    manager,
    broker,
    store,
    io,
    provider,
    users,
    projects: new ProjectPicker(config.projectsRoot),
    logger,
    now,
    pathExists,
  });
  await bot.api.setMyCommands(BOT_COMMANDS);

  if (quarantinedPath) {
    logger.error({ quarantinedPath }, 'state file was corrupt and has been quarantined');
    for (const user of users.current()) {
      if (user.userId === null) continue;
      await io.sendNotice(user.userId, `⚠️ File trạng thái bị hỏng, đã chuyển sang ${quarantinedPath} và bắt đầu lại từ đầu.`);
    }
  }
  await manager.recoverAfterRestart();
  await limits.restore();
  manager.startIdleTimer();

  let started = false;
  let resolveStarted: (username: string) => void = () => undefined;
  const startedSignal = new Promise<string>((resolve) => {
    resolveStarted = resolve;
  });
  const polling = bot.start({
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query'],
    onStart: (me) => {
      started = true;
      resolveStarted(me.username);
    },
  });
  // Only failures before onStart belong to startup; later ones surface through `done`.
  const failedBeforeStart = polling.then(
    () => {
      if (!started) throw new Error('Telegram polling stopped before it started');
    },
    (error: unknown) => {
      if (!started) throw error;
    },
  );

  let botUsername: string;
  try {
    botUsername = await Promise.race([startedSignal, failedBeforeStart.then(() => startedSignal)]);
  } catch (error) {
    manager.stopIdleTimer();
    limits.dispose();
    throw error;
  }
  logger.info({ username: botUsername, provider: provider.id, projectsRoot: config.projectsRoot }, 'agentpager is polling Telegram');

  let stopping: Promise<void> | null = null;
  return {
    botUsername,
    provider: provider.id,
    done: polling,
    shutdown: () => {
      stopping ??= (async () => {
        logger.info('shutting down worker');
        await bot.stop();
        await manager.shutdown();
        limits.dispose();
        await lock.release();
        logger.info('agentpager worker stopped');
      })();
      return stopping;
    },
    reloadUsers: () => users.reload(),
  };
}

/** Builds and starts the bot from the app-data config; ConfigError and LockHeldError propagate to the caller. */
export async function startWorker(deps: WorkerDeps): Promise<WorkerHandle> {
  const catalog = deps.catalog ?? providerCatalog;
  const configStore = new ConfigStore(deps.paths.config, { platform: deps.platform.platform, catalog });
  const config = await configStore.read();
  const logger = deps.logger ?? createLogger(config.logLevel, deps.paths.logs);
  const lock = await acquireLock(deps.paths.lock);
  try {
    return await run(deps, config, configStore, catalog, logger, lock);
  } catch (error) {
    await lock.release();
    throw error;
  }
}
