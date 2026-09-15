import { posix, win32 } from 'node:path';
import {
  ConfigError,
  isValidBotToken,
  normalizeUsername,
  type AgentpagerConfig,
  type AllowedUser,
} from '../../core/config/schema.js';
import type { ProviderCatalogEntry } from '../../providers/types.js';
import type { CliIo } from '../io.js';
import type { CliDeps, Command } from '../types.js';
import { autostartHomeProblem, autostartTarget } from './autostart.js';
import { daemonStatus, messageOf, restartDaemon, startDaemon } from './daemonControl.js';

const DEFAULT_IDLE_MINUTES = 60;

function isAbsolutePath(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path);
}

async function askToken(io: CliIo, deps: CliDeps): Promise<{ token: string; botUsername: string }> {
  for (;;) {
    const token = (await io.ask('Bot token from @BotFather: ', { hidden: true })).trim();
    if (!isValidBotToken(token)) {
      io.err('❌ The token is not in the BotFather format <number>:<string>.');
      continue;
    }
    try {
      const me = await deps.telegram.getMe(token);
      io.out(`✅ Bot @${me.username}`);
      return { token, botUsername: me.username };
    } catch (error) {
      io.err(`❌ The token does not work: ${messageOf(error)}`);
    }
  }
}

async function askUsers(io: CliIo): Promise<AllowedUser[]> {
  for (;;) {
    const parts = (await io.ask('Telegram usernames allowed to use the bot (e.g. @alice, @bob): '))
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) {
      io.err('❌ At least 1 username is required.');
      continue;
    }
    try {
      const users: AllowedUser[] = [];
      for (const part of parts) {
        const username = normalizeUsername(part);
        if (!users.some((user) => user.username === username)) users.push({ username, userId: null, pairedAt: null });
      }
      return users;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      io.err(`❌ ${error.issues.join('; ')}`);
    }
  }
}

async function defaultProjectsRoot(deps: CliDeps): Promise<string> {
  const { platform, homedir } = deps.platform;
  const candidate = platform === 'win32' ? 'D:\\Projects' : posix.join(homedir, 'Projects');
  return (await deps.exists(candidate)) ? candidate : homedir;
}

async function askProjectsRoot(io: CliIo, deps: CliDeps): Promise<string> {
  const fallback = await defaultProjectsRoot(deps);
  for (;;) {
    const answer = (await io.ask('Folder that contains your projects: ', { defaultValue: fallback })).trim() || fallback;
    if (!isAbsolutePath(answer)) {
      io.err(`❌ An absolute path is required: ${answer}`);
      continue;
    }
    if (!(await deps.exists(answer))) {
      io.err(`❌ Folder not found: ${answer}`);
      continue;
    }
    return answer;
  }
}

function chooseProvider(io: CliIo, deps: CliDeps): ProviderCatalogEntry {
  const entry = deps.catalog[0];
  if (!entry) throw new Error('No agent providers are available');
  io.out(`Agent: ${entry.displayName}`);
  return entry;
}

async function askExecutable(io: CliIo, entry: ProviderCatalogEntry, deps: CliDeps): Promise<string | null> {
  const detection = await entry.detect({ executable: null });
  if (detection.executable !== null) {
    io.out(`🔎 ${entry.displayName} CLI: ${detection.executable}${detection.version ? ` (${detection.version})` : ''}`);
  }
  for (const problem of detection.problems) io.out(`  ⚠️ ${problem}`);

  for (;;) {
    const answer = (
      await io.ask(detection.executable !== null ? 'CLI path (Enter to use the path above): ' : 'CLI path (Enter to use the one bundled with the SDK): ')
    ).trim();
    if (answer === '') return detection.executable;
    if (!isAbsolutePath(answer)) {
      io.err(`❌ An absolute path is required: ${answer}`);
      continue;
    }
    if (!(await deps.exists(answer))) {
      io.err(`❌ File not found: ${answer}`);
      continue;
    }
    return answer;
  }
}

async function askIdleMinutes(io: CliIo): Promise<number> {
  for (;;) {
    const answer = (await io.ask('Idle minutes before a session ends: ', { defaultValue: String(DEFAULT_IDLE_MINUTES) })).trim();
    if (/^\d+$/.test(answer) && Number(answer) >= 1) return Number(answer);
    io.err('❌ An integer ≥ 1 is required.');
  }
}

async function offerAutostart(io: CliIo, deps: CliDeps): Promise<void> {
  if (deps.platform.platform !== 'win32' && deps.platform.platform !== 'darwin') return;
  const homeProblem = autostartHomeProblem(deps);
  if (homeProblem !== null) {
    io.out(`ℹ️ Skipping autostart: ${homeProblem}`);
    return;
  }
  if (!(await io.confirm('Start agentpager at login?', true))) return;
  try {
    for (const message of await deps.autostart.enable(autostartTarget(deps))) io.out(message);
  } catch (error) {
    // Setup is already saved; report the autostart failure and let the user retry with "autostart on".
    io.err(`❌ ${messageOf(error)} — try again with "agentpager autostart on".`);
  }
}

async function offerStart(io: CliIo, deps: CliDeps): Promise<number> {
  const running = await daemonStatus(deps);
  if (running) {
    if (!(await io.confirm('agentpager is running. Restart it to apply the new config?', true))) return 0;
    return restartDaemon(io, deps, running);
  }
  if (!(await io.confirm('Start agentpager now?', true))) return 0;
  return startDaemon(io, deps);
}

export const setupCommand: Command = async (_args, io, deps) => {
  if ((await deps.configStore.exists()) && !(await io.confirm(`A config already exists at ${deps.paths.config}. Overwrite it?`, false))) {
    io.out('Keeping the current config.');
    return 0;
  }

  const { token, botUsername } = await askToken(io, deps);
  const allowedUsers = await askUsers(io);
  const projectsRoot = await askProjectsRoot(io, deps);
  const entry = chooseProvider(io, deps);
  const executable = await askExecutable(io, entry, deps);
  const idleTimeoutMinutes = await askIdleMinutes(io);

  const config: AgentpagerConfig = {
    version: 1,
    telegram: { botToken: token },
    allowedUsers,
    projectsRoot,
    idleTimeoutMinutes,
    logLevel: 'info',
    agent: { provider: entry.id, executable, defaultModel: null, defaultEffort: null },
  };
  await deps.configStore.write(config);
  io.out(`✅ Config saved: ${deps.paths.config}`);
  io.out(`👉 Send any message to @${botUsername} from ${allowedUsers.map((user) => `@${user.username}`).join(', ')} to pair the account.`);

  await offerAutostart(io, deps);
  return offerStart(io, deps);
};
