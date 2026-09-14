import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { runDaemon } from '@chiennguyen/agentpager/daemon';
import { appPaths, currentPlatform } from '@chiennguyen/agentpager/platform';

export interface AppProcessInfo {
  execPath: string;
  isPackaged: boolean;
  /** `app.getAppPath()`: the app folder in development, `resources/app.asar` when packaged. */
  appPath: string;
}

/** The command that runs this app as the agentpager daemon, used for Start and for autostart. */
export function daemonCommand(info: AppProcessInfo): { command: string; args: string[] } {
  return info.isPackaged
    ? { command: info.execPath, args: ['--daemon'] }
    : { command: info.execPath, args: [info.appPath, '--daemon'] };
}

/** The installed core package: holds guard-rules.default.json and its version. */
export function corePackageRoot(): string {
  return dirname(createRequire(import.meta.url).resolve('@chiennguyen/agentpager/package.json'));
}

export function runAppDaemon(info: AppProcessInfo): Promise<number> {
  const platform = currentPlatform();
  return runDaemon({
    paths: appPaths(platform),
    platform,
    packageRoot: corePackageRoot(),
    foreground: false,
    launcher: { kind: 'app', executable: info.execPath },
    // fork() uses this executable (Electron); the worker must run as plain Node.
    workerEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });
}
