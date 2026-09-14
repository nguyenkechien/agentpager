import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { BOT_COMMANDS } from '../../src/core/bot/bot.js';
import type { BotDeps } from '../../src/core/bot/deps.js';
import { ConfigError, type AgentpagerConfig } from '../../src/core/config/schema.js';
import { ConfigStore } from '../../src/core/config/store.js';
import { GuardRulesError } from '../../src/core/guard/policy.js';
import { startWorker, type WorkerDeps } from '../../src/core/worker.js';
import { appPaths, type AppPaths } from '../../src/platform/paths.js';
import type { ProviderContext } from '../../src/providers/types.js';
import { LockHeldError } from '../../src/util/lock.js';
import { createFakeProvider } from '../support/fakeProvider.js';

const packageRoot = join(import.meta.dirname, '..', '..');
const logger = pino({ level: 'silent' });
const TOKEN = '123456:ABCdefGHIjklMNOpqrSTUvwx';

function config(): AgentpagerConfig {
  return {
    version: 1,
    telegram: { botToken: TOKEN },
    allowedUsers: [{ username: 'example_user', userId: null, pairedAt: null }],
    projectsRoot: tmpdir(),
    idleTimeoutMinutes: 30,
    logLevel: 'info',
    agent: { provider: 'fake', executable: null, defaultModel: null, defaultEffort: null },
  };
}

interface FakeBotState {
  deps: BotDeps | null;
  commands: unknown;
  stopped: boolean;
  startError: Error | null;
}

function fakeBotFactory(): { state: FakeBotState; createBot: NonNullable<WorkerDeps['createBot']> } {
  const state: FakeBotState = { deps: null, commands: null, stopped: false, startError: null };
  const createBot = (botDeps: BotDeps): Bot => {
    state.deps = botDeps;
    let finish: () => void = () => undefined;
    const bot = {
      api: {
        setMyCommands: (commands: unknown) => {
          state.commands = commands;
          return Promise.resolve(true);
        },
      },
      start: (options: { onStart?: (me: { username: string }) => void }) => {
        if (state.startError) return Promise.reject(state.startError);
        return new Promise<void>((resolve) => {
          finish = resolve;
          options.onStart?.({ username: 'test_bot' });
        });
      },
      stop: () => {
        state.stopped = true;
        finish();
        return Promise.resolve();
      },
    };
    return bot as unknown as Bot;
  };
  return { state, createBot };
}

let paths: AppPaths;
let contexts: ProviderContext[];
let bot: ReturnType<typeof fakeBotFactory>;
let deps: WorkerDeps;

beforeEach(async () => {
  const home = mkdtempSync(join(tmpdir(), 'pager-worker-'));
  const platform = { platform: process.platform, env: { AGENTPAGER_HOME: home }, homedir: home, username: 'tester' };
  paths = appPaths(platform);
  const fake = createFakeProvider();
  contexts = [];
  bot = fakeBotFactory();
  deps = {
    paths,
    platform,
    packageRoot,
    catalog: [fake.provider],
    createProvider: (_id, _settings, context) => {
      contexts.push(context);
      return fake.provider;
    },
    createBot: bot.createBot,
    logger,
  };
  await new ConfigStore(paths.config, { platform: process.platform, catalog: [fake.provider] }).write(config());
});

describe('startWorker', () => {
  it('starts the bot from the app-data config and shuts down cleanly', async () => {
    const handle = await startWorker(deps);
    expect(handle).toMatchObject({ botUsername: 'test_bot', provider: 'fake' });
    expect(bot.state.commands).toEqual(BOT_COMMANDS);
    expect(bot.state.deps?.settings).toEqual({ botToken: TOKEN, uploadsDir: paths.uploads, idleTimeoutMs: 30 * 60_000 });
    expect(bot.state.deps?.users.current()).toEqual(config().allowedUsers);
    expect(existsSync(paths.lock)).toBe(true);

    const context = contexts[0];
    expect(context?.guard.match('git push -f origin main')?.id).toBe('force-push-main');
    expect(context?.systemPrompt).toContain('agentpager');

    await handle.shutdown();
    await expect(handle.done).resolves.toBeUndefined();
    expect(bot.state.stopped).toBe(true);
    expect(existsSync(paths.lock)).toBe(false);
  });

  it('fails with a ConfigError before taking the lock when there is no config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pager-worker-empty-'));
    const emptyPaths = appPaths({ platform: process.platform, env: { AGENTPAGER_HOME: home }, homedir: home, username: 't' });
    await expect(startWorker({ ...deps, paths: emptyPaths })).rejects.toBeInstanceOf(ConfigError);
    expect(existsSync(emptyPaths.lock)).toBe(false);
  });

  it('refuses to start while another instance holds the lock', async () => {
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.lock, String(process.ppid));
    await expect(startWorker(deps)).rejects.toBeInstanceOf(LockHeldError);
  });

  it('prefers a guard rules file in app-data over the defaults', async () => {
    writeFileSync(paths.guardRules, JSON.stringify([{ id: 'custom', pattern: 'forbidden', reason: 'custom rule' }]));
    const handle = await startWorker(deps);
    expect(contexts[0]?.guard.match('run forbidden thing')?.id).toBe('custom');
    expect(contexts[0]?.guard.match('git push -f origin main')).toBeNull();
    await handle.shutdown();
  });

  it('releases the lock when the guard rules are invalid', async () => {
    writeFileSync(paths.guardRules, '{ broken');
    await expect(startWorker(deps)).rejects.toBeInstanceOf(GuardRulesError);
    expect(existsSync(paths.lock)).toBe(false);
  });

  it('releases the lock when Telegram polling fails to start, so a retry can succeed', async () => {
    bot.state.startError = new Error('401: Unauthorized');
    await expect(startWorker(deps)).rejects.toThrow('401: Unauthorized');
    expect(existsSync(paths.lock)).toBe(false);

    bot.state.startError = null;
    const handle = await startWorker(deps);
    await handle.shutdown();
  });

  it('reloads allowed users edited while running', async () => {
    const handle = await startWorker(deps);
    const store = new ConfigStore(paths.config, { platform: process.platform, catalog: deps.catalog ?? [] });
    await store.update((current) => ({
      ...current,
      allowedUsers: [...current.allowedUsers, { username: 'new_friend', userId: null, pairedAt: null }],
    }));
    await handle.reloadUsers();
    expect(bot.state.deps?.users.current()).toContainEqual({ username: 'new_friend', userId: null, pairedAt: null });
    await handle.shutdown();
  });
});
