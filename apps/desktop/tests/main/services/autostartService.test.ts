import type { Autostart, AutostartStatus, AutostartTarget } from '@chiennguyen/agentpager/platform';
import { describe, expect, it } from 'vitest';
import { appAutostartTarget, AutostartService } from '../../../src/main/services/autostartService.js';

const appTarget = appAutostartTarget({ command: 'C:\\Programs\\agentpager\\agentpager.exe', args: ['--daemon'] }, 'C:\\Users\\alex');

function fakeAutostart(initial: AutostartStatus): { autostart: Autostart; calls: string[]; state: { status: AutostartStatus } } {
  const calls: string[] = [];
  const state = { status: initial };
  const autostart: Autostart = {
    enable: (target: AutostartTarget) => {
      calls.push(`enable:${target.command} ${target.args.join(' ')}|${target.workingDir}|${String(target.console)}`);
      state.status = { enabled: true, target, problems: [] };
      return Promise.resolve(['Đã bật']);
    },
    disable: () => {
      calls.push('disable');
      state.status = { enabled: false, target: null, problems: [] };
      return Promise.resolve(['Đã tắt']);
    },
    status: () => Promise.resolve(state.status),
  };
  return { autostart, calls, state };
}

describe('appAutostartTarget', () => {
  it('registers the app executable without a console wrapper', () => {
    expect(appTarget).toEqual({
      command: 'C:\\Programs\\agentpager\\agentpager.exe',
      args: ['--daemon'],
      workingDir: 'C:\\Users\\alex',
      console: false,
    });
  });
});

describe('AutostartService', () => {
  it('recognises its own registration regardless of path casing on Windows', async () => {
    const fake = fakeAutostart({
      enabled: true,
      target: { ...appTarget, command: 'c:\\programs\\AGENTPAGER\\agentpager.exe' },
      problems: [],
    });
    await expect(new AutostartService({ autostart: fake.autostart, target: appTarget, platform: 'win32' }).get()).resolves.toEqual({
      enabled: true,
      command: ['c:\\programs\\AGENTPAGER\\agentpager.exe', '--daemon'],
      ownedByThisApp: true,
      problems: [],
    });
    await expect(new AutostartService({ autostart: fake.autostart, target: appTarget, platform: 'darwin' }).get()).resolves.toMatchObject({
      ownedByThisApp: false,
    });
  });

  it('reports a registration that belongs to the npm CLI', async () => {
    const fake = fakeAutostart({
      enabled: true,
      target: { command: 'C:\\node\\node.exe', args: ['C:\\npm\\agentpager\\dist\\cli\\main.js', 'daemon'], workingDir: 'C:\\', console: true },
      problems: ['Không còn tìm thấy C:\\node\\node.exe'],
    });
    await expect(new AutostartService({ autostart: fake.autostart, target: appTarget, platform: 'win32' }).get()).resolves.toEqual({
      enabled: true,
      command: ['C:\\node\\node.exe', 'C:\\npm\\agentpager\\dist\\cli\\main.js', 'daemon'],
      ownedByThisApp: false,
      problems: ['Không còn tìm thấy C:\\node\\node.exe'],
    });
  });

  it('turns autostart on with this app and off again', async () => {
    const fake = fakeAutostart({ enabled: false, target: null, problems: [] });
    const service = new AutostartService({ autostart: fake.autostart, target: appTarget, platform: 'win32' });
    await expect(service.get()).resolves.toEqual({ enabled: false, command: null, ownedByThisApp: false, problems: [] });
    await expect(service.set(true)).resolves.toMatchObject({ enabled: true, ownedByThisApp: true });
    await expect(service.set(false)).resolves.toMatchObject({ enabled: false });
    expect(fake.calls).toEqual(['enable:C:\\Programs\\agentpager\\agentpager.exe --daemon|C:\\Users\\alex|false', 'disable']);
  });

  it('lets enable failures reach the caller', async () => {
    const fake = fakeAutostart({ enabled: false, target: null, problems: [] });
    fake.autostart.enable = () => Promise.reject(new Error('Access is denied.'));
    await expect(new AutostartService({ autostart: fake.autostart, target: appTarget, platform: 'win32' }).set(true)).rejects.toThrow(
      'Access is denied.',
    );
  });
});
