import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { corePackageRoot, daemonCommand, daemonSpawnEnv, spawnAppDaemon } from '../../src/main/daemonProcess.js';

describe('daemonCommand', () => {
  it('runs the packaged executable with --daemon', () => {
    expect(
      daemonCommand({ execPath: 'C:\\agentpager\\agentpager.exe', isPackaged: true, appPath: 'C:\\agentpager\\resources\\app.asar' }),
    ).toEqual({ command: 'C:\\agentpager\\agentpager.exe', args: ['--daemon'] });
  });

  it('passes the app folder to the electron binary in development', () => {
    expect(
      daemonCommand({ execPath: 'D:\\node_modules\\electron\\dist\\electron.exe', isPackaged: false, appPath: 'D:\\apps\\desktop' }),
    ).toEqual({ command: 'D:\\node_modules\\electron\\dist\\electron.exe', args: ['D:\\apps\\desktop', '--daemon'] });
  });
});

describe('daemonSpawnEnv', () => {
  it('points the daemon at the app-data folder and never runs it as plain Node', () => {
    const env = { PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', AGENTPAGER_HOME: 'D:\\old' };
    expect(daemonSpawnEnv(env, 'C:\\Users\\alex\\AppData\\Roaming\\agentpager')).toEqual({
      PATH: 'C:\\Windows',
      AGENTPAGER_HOME: 'C:\\Users\\alex\\AppData\\Roaming\\agentpager',
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('spawnAppDaemon', () => {
  it('starts the daemon command detached and hidden, then lets it go', () => {
    const spawned: { command: string; args: string[]; options: SpawnOptions }[] = [];
    let unrefs = 0;
    spawnAppDaemon(
      { execPath: 'C:\\agentpager\\agentpager.exe', isPackaged: true, appPath: 'C:\\agentpager\\resources\\app.asar' },
      'C:\\Users\\alex\\AppData\\Roaming\\agentpager',
      'C:\\Users\\alex',
      (command, args, options) => {
        spawned.push({ command, args, options });
        return {
          unref: () => {
            unrefs += 1;
          },
        };
      },
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      command: 'C:\\agentpager\\agentpager.exe',
      args: ['--daemon'],
      options: { detached: true, stdio: 'ignore', windowsHide: true, cwd: 'C:\\Users\\alex' },
    });
    expect(spawned[0]?.options.env?.AGENTPAGER_HOME).toBe('C:\\Users\\alex\\AppData\\Roaming\\agentpager');
    expect(spawned[0]?.options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(unrefs).toBe(1);
  });
});

describe('corePackageRoot', () => {
  it('finds the installed core package with its default guard rules', () => {
    expect(existsSync(join(corePackageRoot(), 'guard-rules.default.json'))).toBe(true);
  });
});
