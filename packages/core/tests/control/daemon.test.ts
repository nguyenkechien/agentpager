import { describe, expect, it } from 'vitest';
import {
  notifyUsersChanged,
  pollDaemonStatus,
  readDaemonStatus,
  restartDaemon,
  START_TIMEOUT_MS,
  startDaemon,
  STOP_TIMEOUT_MS,
  stopDaemon,
  type DaemonControlDeps,
} from '../../src/control/daemon.js';
import { IpcError, type IpcCommand } from '../../src/daemon/ipc.js';
import type { SupervisorStatus } from '../../src/daemon/supervisor.js';

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

const notRunning = (): IpcError => new IpcError('not_running', 'agentpager không chạy');

interface Harness {
  deps: DaemonControlDeps;
  calls: IpcCommand[];
  spawned: () => number;
  elapsed: () => number;
}

/** `respond` returns the IPC data or throws the IPC error for the n-th call (1-based). */
function harness(respond: (command: IpcCommand, call: number) => unknown, fatal: string | null = null): Harness {
  const calls: IpcCommand[] = [];
  let clock = 1_000;
  let spawned = 0;
  const deps: DaemonControlDeps = {
    ipc: (command) => {
      calls.push(command);
      try {
        return Promise.resolve(respond(command, calls.length));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    spawnDaemon: () => {
      spawned += 1;
    },
    lastDaemonFatal: () => Promise.resolve(fatal),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
  return { deps, calls, spawned: () => spawned, elapsed: () => clock - 1_000 };
}

function throws(error: Error): () => never {
  return () => {
    throw error;
  };
}

describe('readDaemonStatus', () => {
  it('parses the status, returns null when nothing runs and rethrows other IPC errors', async () => {
    await expect(readDaemonStatus(harness(() => status()).deps)).resolves.toEqual(status());
    await expect(readDaemonStatus(harness(throws(notRunning())).deps)).resolves.toBeNull();
    await expect(readDaemonStatus(harness(throws(new IpcError('timeout', 'Daemon không phản hồi sau 5000 ms'))).deps)).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('rejects a status with the wrong shape', async () => {
    await expect(readDaemonStatus(harness(() => ({ pid: 'x' })).deps)).rejects.toThrow();
  });
});

describe('pollDaemonStatus', () => {
  it('turns IPC failures other than not_running into unavailable', async () => {
    await expect(pollDaemonStatus(harness(throws(new IpcError('unauthorized', 'Sai token'))).deps)).resolves.toBe('unavailable');
    await expect(pollDaemonStatus(harness(throws(notRunning())).deps)).resolves.toBeNull();
    await expect(pollDaemonStatus(harness(throws(new Error('boom'))).deps)).rejects.toThrow('boom');
  });
});

describe('startDaemon', () => {
  it('reports a daemon that already runs without spawning', async () => {
    const h = harness(() => status());
    await expect(startDaemon(h.deps)).resolves.toEqual({ kind: 'already_running', status: status() });
    expect(h.spawned()).toBe(0);
  });

  it('spawns and waits until the worker is running', async () => {
    const h = harness((_command, call) => {
      if (call === 1) throw notRunning();
      return call < 4 ? status({ workerState: 'starting' }) : status();
    });
    await expect(startDaemon(h.deps)).resolves.toEqual({ kind: 'running', status: status() });
    expect(h.spawned()).toBe(1);
    expect(h.calls).toEqual(['status', 'status', 'status', 'status']);
  });

  it('returns the fatal worker error', async () => {
    const h = harness(throws(notRunning()), 'Token Telegram không hợp lệ (401 Unauthorized)');
    await expect(startDaemon(h.deps)).resolves.toEqual({ kind: 'fatal', message: 'Token Telegram không hợp lệ (401 Unauthorized)' });
  });

  it('times out after the start timeout', async () => {
    const h = harness(throws(notRunning()));
    await expect(startDaemon(h.deps)).resolves.toEqual({ kind: 'timeout' });
    expect(h.elapsed()).toBeGreaterThanOrEqual(START_TIMEOUT_MS);
  });

  it('keeps waiting while the status request itself fails', async () => {
    const h = harness((_command, call) => {
      if (call === 1) throw notRunning();
      if (call === 2) throw new IpcError('failed', 'Daemon đóng kết nối mà không trả lời');
      return status();
    });
    await expect(startDaemon(h.deps)).resolves.toEqual({ kind: 'running', status: status() });
  });
});

describe('restartDaemon', () => {
  it('asks the daemon to restart, reports the request and waits for a new worker', async () => {
    const h = harness((command, call) => {
      if (command === 'restart') return { restarting: true };
      return call < 3 ? status({ workerState: 'running' }) : status({ workerPid: 101, restarts: 1 });
    });
    const events: string[] = [];
    const result = await restartDaemon(h.deps, status(), () => {
      events.push(`requested after ${h.calls.join(',')}`);
    });
    expect(result).toEqual({ kind: 'running', status: status({ workerPid: 101, restarts: 1 }) });
    expect(events).toEqual(['requested after restart']);
  });

  it('does not report a request the daemon refused', async () => {
    const h = harness(throws(notRunning()));
    const events: string[] = [];
    await expect(
      restartDaemon(h.deps, status(), () => {
        events.push('requested');
      }),
    ).rejects.toMatchObject({ code: 'not_running' });
    expect(events).toEqual([]);
  });
});

describe('stopDaemon', () => {
  it('reports when nothing runs', async () => {
    await expect(stopDaemon(harness(throws(notRunning())).deps)).resolves.toEqual({ kind: 'not_running' });
  });

  it('waits until the daemon no longer answers', async () => {
    const h = harness((command, call) => {
      if (command === 'stop') return { stopping: true };
      if (call < 3) return status();
      throw notRunning();
    });
    await expect(stopDaemon(h.deps)).resolves.toEqual({ kind: 'stopped' });
  });

  it('times out when the daemon keeps answering', async () => {
    const h = harness(() => status());
    await expect(stopDaemon(h.deps)).resolves.toEqual({ kind: 'timeout' });
    expect(h.elapsed()).toBeGreaterThanOrEqual(STOP_TIMEOUT_MS);
  });
});

describe('notifyUsersChanged', () => {
  it('distinguishes reloaded, not running and failed', async () => {
    await expect(notifyUsersChanged(harness(() => ({ reloaded: true })).deps)).resolves.toEqual({ kind: 'reloaded' });
    await expect(notifyUsersChanged(harness(throws(notRunning())).deps)).resolves.toEqual({ kind: 'not_running' });
    await expect(notifyUsersChanged(harness(throws(new IpcError('failed', 'Daemon báo lỗi: Worker chưa chạy'))).deps)).resolves.toEqual({
      kind: 'failed',
      code: 'failed',
      message: 'Daemon báo lỗi: Worker chưa chạy',
    });
  });
});
