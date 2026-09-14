import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { posix, win32 } from 'node:path';

export interface PlatformInfo {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
  username: string;
}

export interface AppPaths {
  root: string;
  config: string;
  state: string;
  daemonInfo: string;
  lock: string;
  guardRules: string;
  uploads: string;
  logs: string;
  ipc: string;
}

const APP_DIR = 'agentpager';
const FALLBACK_USERNAME = 'user';

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function currentUsername(env: Record<string, string | undefined>): string {
  try {
    return userInfo().username;
  } catch {
    // userInfo() throws when the uid has no passwd entry (some containers); the environment is the next best source.
    return nonEmpty(env.USERNAME) ?? nonEmpty(env.USER) ?? FALLBACK_USERNAME;
  }
}

export function currentPlatform(): PlatformInfo {
  return { platform: process.platform, env: process.env, homedir: homedir(), username: currentUsername(process.env) };
}

function appRoot(info: PlatformInfo): string {
  const pathApi = info.platform === 'win32' ? win32 : posix;
  const override = nonEmpty(info.env.AGENTPAGER_HOME);
  if (override) return pathApi.isAbsolute(override) ? pathApi.normalize(override) : pathApi.resolve(override);

  if (info.platform === 'win32') {
    const appData = nonEmpty(info.env.APPDATA) ?? win32.join(info.homedir, 'AppData', 'Roaming');
    return win32.join(appData, APP_DIR);
  }
  if (info.platform === 'darwin') return posix.join(info.homedir, 'Library', 'Application Support', APP_DIR);
  const configHome = nonEmpty(info.env.XDG_CONFIG_HOME) ?? posix.join(info.homedir, '.config');
  return posix.join(configHome, APP_DIR);
}

/**
 * Named pipes are per machine, so the pipe name carries the user to keep users apart. An AGENTPAGER_HOME override
 * also gets its own pipe (short hash of the folder), otherwise its daemon would collide with the default one.
 */
function pipeName(username: string, overrideRoot: string | null): string {
  const safe = username.replace(/[^A-Za-z0-9_-]/g, '_') || FALLBACK_USERNAME;
  if (overrideRoot === null) return `\\\\.\\pipe\\${APP_DIR}-${safe}`;
  // Windows paths are case-insensitive: D:\AP and d:\ap are the same home.
  const home = createHash('sha256').update(overrideRoot.toLowerCase()).digest('hex').slice(0, 8);
  return `\\\\.\\pipe\\${APP_DIR}-${safe}-${home}`;
}

export function appPaths(info: PlatformInfo): AppPaths {
  const pathApi = info.platform === 'win32' ? win32 : posix;
  const root = appRoot(info);
  return {
    root,
    config: pathApi.join(root, 'config.json'),
    state: pathApi.join(root, 'state.json'),
    daemonInfo: pathApi.join(root, 'daemon.json'),
    lock: pathApi.join(root, 'bot.lock'),
    guardRules: pathApi.join(root, 'guard-rules.json'),
    uploads: pathApi.join(root, 'uploads'),
    logs: pathApi.join(root, 'logs'),
    ipc:
      info.platform === 'win32'
        ? pipeName(info.username, nonEmpty(info.env.AGENTPAGER_HOME) === null ? null : root)
        : pathApi.join(root, `${APP_DIR}.sock`),
  };
}
