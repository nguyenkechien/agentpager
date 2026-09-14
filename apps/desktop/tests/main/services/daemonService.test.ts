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

function harness(): { daemon: FakeDaemon; service: DaemonService } {
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
  const notRunning = (): Promise<never> => Promise.reject(new IpcError('not_running', 'agentpager không chạy'));
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
    readDaemonInfo: () => Promise.resolve(daemon.status !== null || daemon.ipcError !== null ? info : null),
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
    expect(toDaemonView(status({ workerState: 'restarting', lastError: 'Worker thoát bất thường (code 1)' }), info, null, null)).toMatchObject({
      badge: 'restarting',
      lastError: 'Worker thoát bất thường (code 1)',
    });
    expect(toDaemonView(status({ workerState: 'stopped' }), info, null, null).badge).toBe('stopped');
    expect(toDaemonView(status({ workerState: 'stopped', lastError: 'Chưa có cấu hình' }), info, null, null).badge).toBe('error');
  });

  it('shows a fatal error from the last start when nothing runs', () => {
    expect(toDaemonView(null, null, null, null)).toMatchObject({ badge: 'stopped', pid: null, lastError: null, launcher: null });
    expect(toDaemonView(null, null, 'Token Telegram không hợp lệ (401 Unauthorized)', null)).toMatchObject({
      badge: 'error',
      lastError: 'Token Telegram không hợp lệ (401 Unauthorized)',
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
    daemon.ipcError = new IpcError('timeout', 'Daemon không phản hồi sau 5000 ms');
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
    daemon.fatal = 'Token Telegram không hợp lệ (401 Unauthorized)';
    await expect(failure(service.start())).resolves.toEqual({ code: 'fatal', message: 'Token Telegram không hợp lệ (401 Unauthorized)' });
    await expect(service.status()).resolves.toMatchObject({ badge: 'error', lastError: 'Token Telegram không hợp lệ (401 Unauthorized)' });
    expect(daemon.fatalQueries.every((since) => since === 1_000_000)).toBe(true);
  });

  it('reports a start that never becomes ready', async () => {
    const { service } = harness();
    await expect(failure(service.start())).resolves.toEqual({
      code: 'timeout',
      message: 'agentpager chưa sẵn sàng sau 20 giây — xem log trong C:\\agentpager\\logs',
    });
  });
});

describe('DaemonService.stop and restart', () => {
  it('stops the daemon and forgets an earlier fatal start', async () => {
    const { daemon, service } = harness();
    daemon.fatal = 'Chưa có cấu hình';
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
      message: 'agentpager chưa dừng sau 25 giây — xem log trong C:\\agentpager\\logs',
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
