import { describe, expect, it } from 'vitest';
import { appPaths, currentPlatform, homeOverride, type PlatformInfo } from '../../src/platform/paths.js';

function info(overrides: Partial<PlatformInfo>): PlatformInfo {
  return { platform: 'win32', env: {}, homedir: 'C:\\Users\\alex', username: 'alex', ...overrides };
}

describe('appPaths on Windows', () => {
  it('uses APPDATA and a per-user named pipe', () => {
    expect(appPaths(info({ env: { APPDATA: 'C:\\Users\\alex\\AppData\\Roaming' } }))).toEqual({
      root: 'C:\\Users\\alex\\AppData\\Roaming\\agentpager',
      config: 'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\config.json',
      state: 'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\state.json',
      daemonInfo: 'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\daemon.json',
      lock: 'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\bot.lock',
      guardRules: 'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\guard-rules.json',
      uploads: 'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\uploads',
      logs: 'C:\\Users\\alex\\AppData\\Roaming\\agentpager\\logs',
      ipc: '\\\\.\\pipe\\agentpager-alex',
    });
  });

  it('falls back to the roaming profile folder without APPDATA', () => {
    expect(appPaths(info({ env: { APPDATA: '  ' } })).root).toBe('C:\\Users\\alex\\AppData\\Roaming\\agentpager');
  });

  it('sanitises the username in the pipe name', () => {
    expect(appPaths(info({ username: 'Zoë Kraus.dev' })).ipc).toBe('\\\\.\\pipe\\agentpager-Zo__Kraus_dev');
    expect(appPaths(info({ username: '' })).ipc).toBe('\\\\.\\pipe\\agentpager-user');
  });
});

describe('appPaths on macOS and Linux', () => {
  it('uses Application Support and a socket inside it on macOS', () => {
    const paths = appPaths(info({ platform: 'darwin', homedir: '/Users/alex' }));
    expect(paths.root).toBe('/Users/alex/Library/Application Support/agentpager');
    expect(paths.config).toBe('/Users/alex/Library/Application Support/agentpager/config.json');
    expect(paths.logs).toBe('/Users/alex/Library/Application Support/agentpager/logs');
    expect(paths.ipc).toBe('/Users/alex/Library/Application Support/agentpager/agentpager.sock');
  });

  it('honours XDG_CONFIG_HOME on Linux and falls back to ~/.config', () => {
    expect(appPaths(info({ platform: 'linux', homedir: '/home/alex', env: { XDG_CONFIG_HOME: '/xdg' } })).root).toBe(
      '/xdg/agentpager',
    );
    expect(appPaths(info({ platform: 'linux', homedir: '/home/alex' })).root).toBe('/home/alex/.config/agentpager');
  });
});

describe('AGENTPAGER_HOME', () => {
  it('overrides the app-data folder on every platform', () => {
    const win = appPaths(info({ env: { AGENTPAGER_HOME: 'D:\\portable\\ap\\', APPDATA: 'C:\\x' } }));
    expect(win.root).toBe('D:\\portable\\ap\\');
    expect(win.state).toBe('D:\\portable\\ap\\state.json');
    expect(win.ipc).toMatch(/^\\\\\.\\pipe\\agentpager-alex-[0-9a-f]{8}$/);

    const mac = appPaths(info({ platform: 'darwin', homedir: '/Users/alex', env: { AGENTPAGER_HOME: '/tmp/ap' } }));
    expect(mac.root).toBe('/tmp/ap');
    expect(mac.ipc).toBe('/tmp/ap/agentpager.sock');
  });

  it('reports the overridden folder, or null for the default one', () => {
    expect(homeOverride(info({}))).toBeNull();
    expect(homeOverride(info({ env: { AGENTPAGER_HOME: '   ' } }))).toBeNull();
    expect(homeOverride(info({ env: { AGENTPAGER_HOME: 'D:\\portable\\ap' } }))).toBe('D:\\portable\\ap');
    expect(homeOverride(info({ platform: 'darwin', homedir: '/Users/alex', env: { AGENTPAGER_HOME: '/tmp/ap' } }))).toBe('/tmp/ap');
  });

  it('gives each overridden home its own Windows pipe, stable across path casing', () => {
    const pipe = (home: string): string => appPaths(info({ env: { AGENTPAGER_HOME: home } })).ipc;
    expect(pipe('D:\\portable\\ap')).toBe(pipe('d:\\PORTABLE\\AP'));
    expect(pipe('D:\\portable\\ap')).not.toBe(pipe('D:\\portable\\other'));
    expect(pipe('D:\\portable\\ap')).not.toBe(appPaths(info({})).ipc);
  });
});

describe('currentPlatform', () => {
  it('describes the running process', () => {
    const current = currentPlatform();
    expect(current.platform).toBe(process.platform);
    expect(current.homedir.length).toBeGreaterThan(0);
    expect(current.username.length).toBeGreaterThan(0);
  });
});
