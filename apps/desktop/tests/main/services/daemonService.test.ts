import { IpcError, type DaemonInfo, type SupervisorStatus } from '@chiennguyen/agentpager/daemon';
import { describe, expect, it } from 'vitest';
import { DaemonService, toDaemonView } from '../../../src/main/services/daemonService.js';
import { toApiError } from '../../../src/main/services/results.js';
import type { ApiError } from '../../../src/shared/api.js';

function status(overrides: Partial<SupervisorStatus> = {}): SupervisorStatus {
  return {
    pid: 42,
    startedAt: '2026-09-14T08:00:00.000Z',
    workerPid: 100,
    workerState: 'running',
    restarts: 0,
    botUsername: 'test_bot',
    provider: 'claude-code',
    lastError: null,
    activeTurns: 0,
    queuedInputs: 0,
    ...overrides,
  };
}

const info: DaemonInfo = {
  pid: 42,
  startedAt: '2026-09-14T08:00:00.000Z',
  ipc: { path: '\\\\.\\pipe\\agentpager-test' },
  token: 'a'.repeat(64),
  launcher: { kind: 'cli', executable: 'C:\\npm\\agentpager\\dist\\cli\\main.js' },
};

interface FakeDaemon {
  status: SupervisorStatus | null;
  ipcError: IpcError | null;
  fatal: string | null;
  fatalQueries: number[];
  spawned: number;
  onSpawn: () => void;
  stops: boolean;
  clock: number;
}

function harness(daemonInfo: DaemonInfo = info): { daemon: FakeDaemon; service: DaemonService } {
  const daemon: FakeDaemon = {
    status: null,
    ipcError: null,
    fatal: null,
    fatalQueries: [],
    spawned: 0,
    onSpawn: () => undefined,
    stops: true,
    clock: 1_000_000,
  };
  const notRunning = (): Promise<never> => Promise.reject(new IpcError('not_running', 'agentpager is not running'));
  const service = new DaemonService({
    ipc: (command) => {
      if (daemon.ipcError) return Promise.reject(daemon.ipcError);
      const current = daemon.status;
      if (current === null) return notRunning();
      switch (command) {
        case 'stop':
          if (daemon.stops) daemon.status = null;
          return Promise.resolve({ stopping: true });
        case 'restart':
          daemon.status = { ...current, workerPid: (current.workerPid ?? 0) + 1, restarts: current.restarts + 1 };
          return Promise.resolve({ restarting: true });
        default:
          return Promise.resolve(current);
      }
    },
    spawnDaemon: () => {
      daemon.spawned += 1;
      daemon.onSpawn();
    },
    lastDaemonFatal: (since) => {
      daemon.fatalQueries.push(since);
      return Promise.resolve(daemon.fatal);
    },
    sleep: (ms) => {
      daemon.clock += ms;
      return Promise.resolve();
    },
    now: () => daemon.clock,
    readDaemonInfo: () => Promise.resolve(daemon.status !== null || daemon.ipcError !== null ? daemonInfo : null),
    logsDir: 'C:\\agentpager\\logs',
  });
  return { daemon, service };
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return toApiError(error);
  }
  throw new Error('expected the call to fail');
}

describe('toDaemonView', () => {
  it('maps worker states to badges', () => {
    expect(toDaemonView(status(), info, null, null)).toEqual({
      badge: 'running',
      pid: 42,
      startedAt: '2026-09-14T08:00:00.000Z',
      workerPid: 100,
      restarts: 0,
      botUsername: 'test_bot',
      provider: 'claude-code',
      lastError: null,
      launcher: { kind: 'cli', executable: 'C:\\npm\\agentpager\\dist\\cli\\main.js' },
    });
    expect(toDaemonView(status({ workerState: 'starting' }), info, null, null).badge).toBe('starting');
    expect(toDaemonView(status({ workerState: 'restarting', lastError: 'Worker exited unexpectedly (code 1)' }), info, null, null)).toMatchObject({
      badge: 'restarting',
      lastError: 'Worker exited unexpectedly (code 1)',
    });
    expect(toDaemonView(status({ workerState: 'stopped' }), info, null, null).badge).toBe('stopped');
    expect(toDaemonView(status({ workerState: 'stopped', lastError: 'No config yet — run "agentpager setup".' }), info, null, null).badge).toBe('error');
  });

  it('shows a fatal error from the last start when nothing runs', () => {
    expect(toDaemonView(null, null, null, null)).toMatchObject({ badge: 'stopped', pid: null, lastError: null, launcher: null });
    expect(toDaemonView(null, null, 'Invalid Telegram token (401 Unauthorized)', null)).toMatchObject({
      badge: 'error',
      lastError: 'Invalid Telegram token (401 Unauthorized)',
    });
  });

  it('never treats an answering daemon as stopped', () => {
    expect(toDaemonView(null, info, null, 'timeout')).toMatchObject({ badge: 'unresponsive', pid: 42, launcher: info.launcher });
    expect(toDaemonView(null, info, null, 'failed').badge).toBe('unresponsive');
    expect(toDaemonView(null, info, null, 'unauthorized').badge).toBe('disconnected');
  });
});

describe('DaemonService.status', () => {
  it('reads the running daemon and its launcher', async () => {
    const { daemon, service } = harness();
    await expect(service.status()).resolves.toMatchObject({ badge: 'stopped' });
    expect(daemon.fatalQueries).toEqual([]);
    daemon.status = status();
    await expect(service.status()).resolves.toMatchObject({ badge: 'running', launcher: { kind: 'cli' } });
    daemon.ipcError = new IpcError('timeout', 'Daemon did not respond after 5000 ms');
    await expect(service.status()).resolves.toMatchObject({ badge: 'unresponsive', pid: 42 });
  });
});

describe('DaemonService.start', () => {
  it('spawns the daemon and returns the running view', async () => {
    const { daemon, service } = harness();
    daemon.onSpawn = () => {
      daemon.status = status();
    };
    await expect(service.start()).resolves.toMatchObject({ badge: 'running', botUsername: 'test_bot' });
    expect(daemon.spawned).toBe(1);
    await expect(service.start()).resolves.toMatchObject({ badge: 'running' });
    expect(daemon.spawned).toBe(1);
  });

  it('reports a fatal start and keeps showing it as the error state', async () => {
    const { daemon, service } = harness();
    daemon.fatal = 'Invalid Telegram token (401 Unauthorized)';
    await expect(failure(service.start())).resolves.toEqual({ code: 'fatal', message: 'Invalid Telegram token (401 Unauthorized)' });
    await expect(service.status()).resolves.toMatchObject({ badge: 'error', lastError: 'Invalid Telegram token (401 Unauthorized)' });
    expect(daemon.fatalQueries.every((since) => since === 1_000_000)).toBe(true);
  });

  it('reports a start that never becomes ready', async () => {
    const { service } = harness();
    await expect(failure(service.start())).resolves.toEqual({
      code: 'timeout',
      message: 'agentpager was not ready after 20 seconds — see the logs in C:\\agentpager\\logs',
    });
  });
});

describe('DaemonService.stop and restart', () => {
  it('stops the daemon and forgets an earlier fatal start', async () => {
    const { daemon, service } = harness();
    daemon.fatal = 'No config yet — run "agentpager setup".';
    await failure(service.start());
    await expect(service.stop()).resolves.toMatchObject({ badge: 'stopped', lastError: null });

    daemon.status = status();
    await expect(service.stop()).resolves.toMatchObject({ badge: 'stopped' });
  });

  it('reports a daemon that does not stop', async () => {
    const { daemon, service } = harness();
    daemon.status = status();
    daemon.stops = false;
    await expect(failure(service.stop())).resolves.toEqual({
      code: 'timeout',
      message: 'agentpager did not stop after 25 seconds — see the logs in C:\\agentpager\\logs',
    });
  });

  it('restarts a running worker and starts a stopped daemon', async () => {
    const { daemon, service } = harness();
    daemon.status = status();
    await expect(service.restart()).resolves.toMatchObject({ badge: 'running', workerPid: 101, restarts: 1 });

    daemon.status = null;
    daemon.onSpawn = () => {
      daemon.status = status({ workerPid: 200 });
    };
    await expect(service.restart()).resolves.toMatchObject({ badge: 'running', workerPid: 200 });
    expect(daemon.spawned).toBe(1);
  });
});

describe('DaemonService.switchToApp', () => {
  it('stops a bot started by the cli and starts it from the app', async () => {
    const { daemon, service } = harness();
    daemon.status = status();
    daemon.onSpawn = () => {
      daemon.status = status({ workerPid: 200 });
    };
    await expect(service.switchToApp()).resolves.toMatchObject({ badge: 'running', workerPid: 200 });
    expect(daemon.spawned).toBe(1);
  });

  it('treats a 0.1.x daemon without a launcher as the cli', async () => {
    const older: DaemonInfo = { pid: info.pid, startedAt: info.startedAt, ipc: info.ipc, token: info.token };
    const { daemon, service } = harness(older);
    daemon.status = status();
    daemon.onSpawn = () => {
      daemon.status = status({ workerPid: 201 });
    };
    await expect(service.switchToApp()).resolves.toMatchObject({ workerPid: 201 });
  });

  it('refuses when the app already runs the bot or nothing runs', async () => {
    const own = harness({ ...info, launcher: { kind: 'app', executable: 'C:\\agentpager\\agentpager.exe' } });
    own.daemon.status = status();
    expect(await failure(own.service.switchToApp())).toEqual({ code: 'invalid_input', message: 'The bot is already running from agentpager app.' });
    expect(own.daemon.status).not.toBeNull();

    const none = harness();
    expect(await failure(none.service.switchToApp())).toEqual({ code: 'not_running', message: 'The bot is not running.' });
  });

  it('does not start a second bot when the cli bot does not stop', async () => {
    const { daemon, service } = harness();
    daemon.status = status();
    daemon.stops = false;
    expect(await failure(service.switchToApp())).toMatchObject({ code: 'timeout' });
    expect(daemon.spawned).toBe(0);
  });
});
