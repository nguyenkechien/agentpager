import type { StopResult } from '@chiennguyen/agentpager/control';
import type { DaemonInfo, SupervisorStatus } from '@chiennguyen/agentpager/daemon';
import { describe, expect, it } from 'vitest';
import {
  isQuitForMaintenance,
  prepareUpdate,
  QUIT_FOR_MAINTENANCE,
  uninstallCleanup,
  type MaintenanceDaemonDeps,
} from '../../../src/main/maintenance/maintenance.js';
import { ownsDaemon } from '../../../src/main/maintenance/ownDaemon.js';
import type { AutostartView } from '../../../src/shared/api.js';

const EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\agentpager\\agentpager.exe';

function info(kind: 'app' | 'cli' | null, executable = EXE): DaemonInfo {
  return {
    pid: 42,
    startedAt: '2026-09-15T08:00:00.000Z',
    ipc: { path: '\\\\.\\pipe\\agentpager' },
    token: 'a'.repeat(64),
    ...(kind === null ? {} : { launcher: { kind, executable } }),
  };
}

const RUNNING: SupervisorStatus = {
  pid: 42,
  startedAt: '2026-09-15T08:00:00.000Z',
  workerPid: 43,
  workerState: 'running',
  restarts: 0,
  botUsername: 'test_bot',
  provider: 'claude-code',
  lastError: null,
  activeTurns: 0,
  queuedInputs: 0,
};

interface Harness {
  events: string[];
  deps: MaintenanceDaemonDeps & { quitGui: () => Promise<void>; writeMarker: () => Promise<void> };
}

function harness(daemon: DaemonInfo | null, status: SupervisorStatus | null, stop: StopResult = { kind: 'stopped' }): Harness {
  const events: string[] = [];
  return {
    events,
    deps: {
      readDaemonInfo: () => Promise.resolve(daemon),
      readStatus: () => Promise.resolve(status),
      stopDaemon: () => {
        events.push('stop');
        return Promise.resolve(stop);
      },
      execPath: EXE,
      platform: 'win32',
      quitGui: () => {
        events.push('quit gui');
        return Promise.resolve();
      },
      writeMarker: () => {
        events.push('marker');
        return Promise.resolve();
      },
    },
  };
}

describe('ownsDaemon', () => {
  it('matches a daemon started from this executable', () => {
    expect(ownsDaemon(info('app'), EXE, 'win32')).toBe(true);
    expect(ownsDaemon(info('app', EXE.toUpperCase()), EXE, 'win32')).toBe(true);
    expect(ownsDaemon(info('app', '/Applications/Agentpager.app/x'), '/Applications/agentpager.app/x', 'darwin')).toBe(false);
    expect(ownsDaemon(info('app', 'D:\\other\\agentpager.exe'), EXE, 'win32')).toBe(false);
    expect(ownsDaemon(info('cli', EXE), EXE, 'win32')).toBe(false);
    expect(ownsDaemon(info(null), EXE, 'win32')).toBe(false);
    expect(ownsDaemon(null, EXE, 'win32')).toBe(false);
  });
});

describe('isQuitForMaintenance', () => {
  it('recognises only the maintenance quit signal', () => {
    expect(isQuitForMaintenance(QUIT_FOR_MAINTENANCE)).toBe(true);
    expect(isQuitForMaintenance({ command: 'show' })).toBe(false);
    expect(isQuitForMaintenance(undefined)).toBe(false);
  });
});

describe('prepareUpdate', () => {
  it('quits the window, writes the marker, then stops a bot running from this installation', async () => {
    const h = harness(info('app'), RUNNING);
    await expect(prepareUpdate(h.deps)).resolves.toBe('stopped');
    expect(h.events).toEqual(['quit gui', 'marker', 'stop']);
  });

  it('leaves bots started by the cli or another copy alone', async () => {
    for (const daemon of [info('cli', 'C:\\npm\\agentpager\\main.js'), info('app', 'D:\\dev\\agentpager.exe'), info(null)]) {
      const h = harness(daemon, RUNNING);
      await expect(prepareUpdate(h.deps)).resolves.toBe('nothing_to_stop');
      expect(h.events).toEqual(['quit gui']);
    }
  });

  it('does nothing when daemon.json is left over from a bot that is gone', async () => {
    const h = harness(info('app'), null);
    await expect(prepareUpdate(h.deps)).resolves.toBe('nothing_to_stop');
    expect(h.events).toEqual(['quit gui']);
  });

  it('fails when the bot does not stop in time, keeping the marker for the next start', async () => {
    const h = harness(info('app'), RUNNING, { kind: 'timeout' });
    await expect(prepareUpdate(h.deps)).rejects.toThrow('did not stop');
    expect(h.events).toEqual(['quit gui', 'marker', 'stop']);
  });
});

describe('uninstallCleanup', () => {
  function autostart(view: AutostartView): { calls: boolean[]; service: { get: () => Promise<AutostartView>; set: (enabled: boolean) => Promise<AutostartView> } } {
    const calls: boolean[] = [];
    return {
      calls,
      service: {
        get: () => Promise.resolve(view),
        set: (enabled) => {
          calls.push(enabled);
          return Promise.resolve({ ...view, enabled });
        },
      },
    };
  }
  const owned: AutostartView = { enabled: true, command: [EXE, '--daemon'], ownedByThisApp: true, problems: [] };
  const foreign: AutostartView = { enabled: true, command: ['node.exe', 'main.js', 'daemon'], ownedByThisApp: false, problems: [] };

  it('stops its own bot without a marker, removes its autostart and the login item', async () => {
    const h = harness(info('app'), RUNNING);
    const start = autostart(owned);
    let loginItemRemoved = false;
    await uninstallCleanup({
      ...h.deps,
      autostart: start.service,
      removeLoginItem: () => {
        loginItemRemoved = true;
      },
      homeOverride: null,
    });
    expect(h.events).toEqual(['quit gui', 'stop']);
    expect(start.calls).toEqual([false]);
    expect(loginItemRemoved).toBe(true);
  });

  it('keeps an autostart that runs the cli', async () => {
    const h = harness(info('cli'), RUNNING);
    const start = autostart(foreign);
    await uninstallCleanup({ ...h.deps, autostart: start.service, removeLoginItem: () => undefined, homeOverride: null });
    expect(h.events).toEqual(['quit gui']);
    expect(start.calls).toEqual([]);
  });

  it('touches no machine-wide settings with AGENTPAGER_HOME set', async () => {
    const h = harness(info('app'), RUNNING);
    const start = autostart(owned);
    let loginItemRemoved = false;
    await uninstallCleanup({
      ...h.deps,
      autostart: start.service,
      removeLoginItem: () => {
        loginItemRemoved = true;
      },
      homeOverride: 'C:\\temp\\home',
    });
    expect(h.events).toEqual(['quit gui', 'stop']);
    expect(start.calls).toEqual([]);
    expect(loginItemRemoved).toBe(false);
  });

  it('still removes autostart when the bot does not stop, then reports the failure', async () => {
    const h = harness(info('app'), RUNNING, { kind: 'timeout' });
    const start = autostart(owned);
    await expect(
      uninstallCleanup({ ...h.deps, autostart: start.service, removeLoginItem: () => undefined, homeOverride: null }),
    ).rejects.toThrow('did not stop');
    expect(start.calls).toEqual([false]);
  });
});
