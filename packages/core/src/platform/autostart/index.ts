import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathExists } from '../../util/fs.js';
import { nodeCommandRunner } from '../commandRunner.js';
import type { AppPaths, PlatformInfo } from '../paths.js';
import { createMacAutostart } from './macos.js';
import { UNSUPPORTED_PLATFORM_MESSAGE, type Autostart, type AutostartDeps } from './types.js';
import { createWindowsAutostart } from './windows.js';

export type { Autostart, AutostartDeps, AutostartStatus, AutostartTarget, CommandRunner } from './types.js';

export function createAutostart(deps: AutostartDeps): Autostart {
  switch (deps.platform) {
    case 'win32':
      return createWindowsAutostart(deps);
    case 'darwin':
      return createMacAutostart(deps);
    default: {
      const unsupported = (): Promise<never> => Promise.reject(new Error(UNSUPPORTED_PLATFORM_MESSAGE));
      return { enable: unsupported, disable: unsupported, status: unsupported };
    }
  }
}

export function defaultAutostartDeps(paths: AppPaths, platform: PlatformInfo): AutostartDeps {
  return {
    platform: platform.platform,
    homedir: platform.homedir,
    // getuid does not exist on Windows, where the uid is not used.
    uid: process.getuid?.() ?? -1,
    paths,
    runner: nodeCommandRunner,
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    removeFile: (path) => rm(path, { force: true }),
    exists: pathExists,
    readFile: async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    makeDir: async (path) => {
      await mkdir(path, { recursive: true });
    },
  };
}
