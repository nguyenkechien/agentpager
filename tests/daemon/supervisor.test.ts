import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Supervisor,
  type FinishReason,
  type SupervisorToWorker,
  type WorkerProcess,
  type WorkerToSupervisor,
} from '../../src/daemon/supervisor.js';

class FakeWorker implements WorkerProcess {
  sent: SupervisorToWorker[] = [];
  killed = false;
  private readonly messageListeners: ((message: WorkerToSupervisor) => void)[] = [];
  private readonly exitListeners: ((code: number | null) => void)[] = [];

  constructor(readonly pid: number) {}

  send(message: SupervisorToWorker): void {
    this.sent.push(message);
  }

  onMessage(listener: (message: WorkerToSupervisor) => void): void {
    this.messageListeners.push(listener);
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }

  kill(): void {
    this.killed = true;
  }

  ready(): void {
    for (const listener of this.messageListeners) listener({ type: 'ready', botUsername: 'test_bot', provider: 'claude-code' });
  }

  fatal(message: string): void {
    for (const listener of this.messageListeners) listener({ type: 'fatal', message });
  }

  exit(code: number | null): void {
    for (const listener of this.exitListeners) listener(code);
  }
}

const SECOND = 1_000;
let workers: FakeWorker[];
let finished: FinishReason[];
let supervisor: Supervisor;

function worker(index: number): FakeWorker {
  const found = workers[index];
  if (!found) throw new Error(`no worker ${index}`);
  return found;
}

function last(): FakeWorker {
  return worker(workers.length - 1);
}

beforeEach(() => {
  vi.useFakeTimers();
  workers = [];
  finished = [];
  supervisor = new Supervisor({
    spawnWorker: () => {
      const created = new FakeWorker(100 + workers.length);
      workers.push(created);
      return created;
    },
    now: () => Date.now(),
    logger: pino({ level: 'silent' }),
    pid: 42,
  });
  supervisor.onFinished((reason) => finished.push(reason));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Supervisor', () => {
  it('starts a worker and reports it running once ready', () => {
    supervisor.start();
    expect(supervisor.status()).toMatchObject({ pid: 42, workerPid: 100, workerState: 'starting', restarts: 0 });
    worker(0).ready();
    expect(supervisor.status()).toMatchObject({
      workerState: 'running',
      botUsername: 'test_bot',
      provider: 'claude-code',
      lastError: null,
    });
  });

  it('restarts crashed workers with doubling backoff capped at 5 minutes', () => {
    supervisor.start();
    const delays: number[] = [];
    for (let crash = 0; crash < 8; crash += 1) {
      const before = workers.length;
      last().exit(1);
      expect(supervisor.status()).toMatchObject({ workerState: 'restarting', workerPid: null });
      let waited = 0;
      while (workers.length === before) {
        vi.advanceTimersByTime(SECOND);
        waited += SECOND;
      }
      delays.push(waited / SECOND);
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
    expect(supervisor.status().restarts).toBe(8);
    expect(supervisor.status().lastError).toBe('Worker thoát bất thường (code 1)');
  });

  it('resets the backoff after a long healthy run', () => {
    supervisor.start();
    last().exit(1);
    vi.advanceTimersByTime(5 * SECOND);
    last().exit(null);
    vi.advanceTimersByTime(10 * SECOND);
    expect(workers).toHaveLength(3);

    last().ready();
    vi.advanceTimersByTime(600 * SECOND);
    last().exit(1);
    vi.advanceTimersByTime(5 * SECOND);
    expect(workers).toHaveLength(4);
  });

  it('stops for good after a fatal worker error', () => {
    supervisor.start();
    worker(0).fatal('Cấu hình không hợp lệ');
    worker(0).exit(1);
    vi.advanceTimersByTime(3_600 * SECOND);
    expect(workers).toHaveLength(1);
    expect(finished).toEqual(['fatal']);
    expect(supervisor.status()).toMatchObject({ workerState: 'stopped', lastError: 'Cấu hình không hợp lệ' });
  });

  it('ends when a worker exits cleanly on its own', () => {
    supervisor.start();
    worker(0).exit(0);
    expect(finished).toEqual(['stopped']);
    vi.advanceTimersByTime(60 * SECOND);
    expect(workers).toHaveLength(1);
  });

  it('stop asks the worker to shut down and waits for it to exit', async () => {
    supervisor.start();
    worker(0).ready();
    let stopped = false;
    const stopping = supervisor.stop().then(() => {
      stopped = true;
    });
    expect(worker(0).sent).toEqual([{ type: 'shutdown' }]);
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(stopped).toBe(false);

    worker(0).exit(0);
    await stopping;
    expect(finished).toEqual(['stopped']);
    expect(worker(0).killed).toBe(false);
    expect(supervisor.stop()).toBe(supervisor.stop());
    vi.advanceTimersByTime(600 * SECOND);
    expect(workers).toHaveLength(1);
  });

  it('kills a worker that does not stop within the timeout', async () => {
    supervisor.start();
    const stopping = supervisor.stop();
    await vi.advanceTimersByTimeAsync(20 * SECOND);
    expect(worker(0).killed).toBe(true);
    worker(0).exit(null);
    await stopping;
    expect(finished).toEqual(['stopped']);
  });

  it('stops immediately while waiting to restart a crashed worker', async () => {
    supervisor.start();
    worker(0).exit(1);
    await supervisor.stop();
    vi.advanceTimersByTime(600 * SECOND);
    expect(workers).toHaveLength(1);
    expect(finished).toEqual(['stopped']);
  });

  it('restart replaces the worker without treating the exit as a crash', async () => {
    supervisor.start();
    worker(0).ready();
    const restarting = supervisor.restart();
    expect(worker(0).sent).toEqual([{ type: 'shutdown' }]);
    expect(supervisor.status().workerState).toBe('restarting');

    worker(0).exit(0);
    await restarting;
    expect(workers).toHaveLength(2);
    expect(supervisor.status()).toMatchObject({ workerState: 'starting', workerPid: 101, restarts: 1 });
    expect(finished).toEqual([]);

    vi.advanceTimersByTime(600 * SECOND);
    expect(workers).toHaveLength(2);
  });

  it('refuses to restart after stopping', async () => {
    supervisor.start();
    const stopping = supervisor.stop();
    worker(0).exit(0);
    await stopping;
    await expect(supervisor.restart()).rejects.toThrow('Supervisor đã dừng');
  });

  it('forwards user reloads only to a running worker', () => {
    supervisor.start();
    expect(() => {
      supervisor.reloadUsers();
    }).toThrow('Worker chưa chạy');
    worker(0).ready();
    supervisor.reloadUsers();
    expect(worker(0).sent).toEqual([{ type: 'reload-users' }]);
  });
});
