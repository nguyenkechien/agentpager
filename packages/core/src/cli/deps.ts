import { spawn } from 'node:child_process';
import { Api } from 'grammy';
import { ConfigStore } from '../core/config/store.js';
import { readDaemonInfo } from '../daemon/daemonInfo.js';
import { ipcRequest } from '../daemon/ipc.js';
import { runDaemon } from '../daemon/main.js';
import { createAutostart, defaultAutostartDeps } from '../platform/autostart/index.js';
import type { AppPaths, PlatformInfo } from '../platform/paths.js';
import { providerCatalog } from '../providers/registry.js';
import { pathExists } from '../util/fs.js';
import { followLog, lastDaemonFatal, readLogTail } from '../control/logFiles.js';
import type { CliDeps } from './types.js';

export interface CliEnvironment {
  paths: AppPaths;
  platform: PlatformInfo;
  packageRoot: string;
  cliPath: string;
  nodePath: string;
  version: string;
}

export function createCliDeps(env: CliEnvironment): CliDeps {
  const { paths, platform } = env;
  const catalog = providerCatalog;
  return {
    ...env,
    catalog,
    configStore: new ConfigStore(paths.config, { platform: platform.platform, catalog }),
    autostart: createAutostart(defaultAutostartDeps(paths, platform)),
    ipc: async (command) => ipcRequest(await readDaemonInfo(paths.daemonInfo), command),
    spawnDaemon: () => {
      // Running from sources (npm run dev) needs the tsx loader in the detached process too.
      const loader = env.cliPath.endsWith('.ts') ? ['--import', 'tsx'] : [];
      const child = spawn(env.nodePath, [...loader, env.cliPath, 'daemon'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: platform.homedir,
        env: { ...process.env, AGENTPAGER_HOME: paths.root },
      });
      child.unref();
    },
    runDaemon: (foreground) =>
      runDaemon({ paths, platform, packageRoot: env.packageRoot, foreground, launcher: { kind: 'cli', executable: env.cliPath } }),
    telegram: {
      getMe: async (token) => ({ username: (await new Api(token).getMe()).username }),
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    now: () => Date.now(),
    readLogTail: (lines) => readLogTail(paths.logs, lines),
    followLog: (onLine) => followLog(paths.logs, onLine),
    waitForInterrupt: () =>
      new Promise((resolve) => {
        process.once('SIGINT', () => {
          resolve();
        });
      }),
    lastDaemonFatal: (sinceMs) => lastDaemonFatal(paths.logs, sinceMs),
    exists: pathExists,
  };
}
