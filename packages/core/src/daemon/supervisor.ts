import type { Logger } from 'pino';

export type WorkerToSupervisor = { type: 'ready'; botUsername: string; provider: string } | { type: 'fatal'; message: string };
export type SupervisorToWorker = { type: 'shutdown' } | { type: 'reload-users' };

export interface WorkerProcess {
  readonly pid: number | undefined;
  send(message: SupervisorToWorker): void;
  onMessage(listener: (message: WorkerToSupervisor) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export type WorkerState = 'starting' | 'running' | 'restarting' | 'stopped';
export type FinishReason = 'stopped' | 'fatal';

export interface SupervisorStatus {
  pid: number;
  startedAt: string;
  workerPid: number | null;
  workerState: WorkerState;
  restarts: number;
  botUsername: string | null;
  provider: string | null;
  lastError: string | null;
}

export interface SupervisorDeps {
  spawnWorker(): WorkerProcess;
  now(): number;
  logger: Logger;
  pid: number;
  stopTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export const INITIAL_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 300_000;
export const HEALTHY_RUN_MS = 600_000;
export const DEFAULT_STOP_TIMEOUT_MS = 20_000;
/** Logged when a worker reports a fatal error; the CLI reads it back from supervisor.log. */
export const FATAL_WORKER_LOG = 'worker reported a fatal error';

interface WorkerEntry {
  worker: WorkerProcess;
  startedAt: number;
  /** Set when stop() or restart() asked this worker to exit, so its exit is not treated as a crash. */
  shuttingDown: boolean;
  fatal: string | null;
  exited: Promise<number | null>;
}

/** Keeps one bot worker alive: restarts crashes with backoff, stops for good on configuration errors. */
export class Supervisor {
  private readonly stopTimeoutMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly finishListeners: ((reason: FinishReason) => void)[] = [];
  private current: WorkerEntry | null = null;
  private state: WorkerState = 'stopped';
  private startedAt = 0;
  private restarts = 0;
  private botUsername: string | null = null;
  private provider: string | null = null;
  private lastError: string | null = null;
  private nextBackoffMs = INITIAL_BACKOFF_MS;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private restarting: Promise<void> | null = null;
  private finished = false;

  constructor(private readonly deps: SupervisorDeps) {
    this.stopTimeoutMs = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  start(): void {
    this.startedAt = this.deps.now();
    this.deps.logger.info({ pid: this.deps.pid }, 'supervisor started');
    this.spawn();
  }

  onFinished(listener: (reason: FinishReason) => void): void {
    this.finishListeners.push(listener);
  }

  status(): SupervisorStatus {
    return {
      pid: this.deps.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      workerPid: this.current?.worker.pid ?? null,
      workerState: this.state,
      restarts: this.restarts,
      botUsername: this.botUsername,
      provider: this.provider,
      lastError: this.lastError,
    };
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.deps.logger.info('stopping supervisor');
      this.cancelRestartTimer();
      const entry = this.current;
      if (entry) await this.shutdownWorker(entry);
      this.finish('stopped');
    })();
    return this.stopping;
  }

  restart(): Promise<void> {
    if (this.finished || this.stopping) return Promise.reject(new Error('Supervisor đã dừng'));
    this.restarting ??= (async () => {
      this.deps.logger.info('restarting worker on request');
      this.cancelRestartTimer();
      this.state = 'restarting';
      const entry = this.current;
      if (entry) await this.shutdownWorker(entry);
      if (this.stopping || this.finished) return;
      this.nextBackoffMs = INITIAL_BACKOFF_MS;
      this.restarts += 1;
      this.spawn();
    })().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }

  reloadUsers(): void {
    const entry = this.current;
    if (!entry || this.state !== 'running') throw new Error('Worker chưa chạy');
    entry.worker.send({ type: 'reload-users' });
  }

  private spawn(): void {
    let resolveExit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const worker = this.deps.spawnWorker();
    const entry: WorkerEntry = { worker, startedAt: this.deps.now(), shuttingDown: false, fatal: null, exited };
    this.current = entry;
    this.state = 'starting';
    this.botUsername = null;
    this.provider = null;
    worker.onMessage((message) => {
      this.handleMessage(entry, message);
    });
    worker.onExit((code) => {
      resolveExit(code);
      this.handleExit(entry, code);
    });
    this.deps.logger.info({ workerPid: worker.pid }, 'worker started');
  }

  private handleMessage(entry: WorkerEntry, message: WorkerToSupervisor): void {
    if (entry !== this.current) return;
    if (message.type === 'ready') {
      this.state = 'running';
      this.botUsername = message.botUsername;
      this.provider = message.provider;
      this.lastError = null;
      this.deps.logger.info({ workerPid: entry.worker.pid, botUsername: message.botUsername }, 'worker ready');
      return;
    }
    entry.fatal = message.message;
    this.lastError = message.message;
    this.deps.logger.error({ workerPid: entry.worker.pid, message: message.message }, FATAL_WORKER_LOG);
  }

  private handleExit(entry: WorkerEntry, code: number | null): void {
    if (entry !== this.current) return;
    this.current = null;
    this.deps.logger.info({ workerPid: entry.worker.pid, code }, 'worker exited');
    // stop() and restart() decide what follows an exit they requested.
    if (entry.shuttingDown || this.stopping) return;
    if (entry.fatal !== null) {
      this.finish('fatal');
      return;
    }
    if (code === 0) {
      this.finish('stopped');
      return;
    }
    this.lastError = `Worker thoát bất thường (code ${code === null ? 'signal' : String(code)})`;
    this.scheduleRestart(this.deps.now() - entry.startedAt);
  }

  private scheduleRestart(ranMs: number): void {
    if (ranMs >= HEALTHY_RUN_MS) this.nextBackoffMs = INITIAL_BACKOFF_MS;
    const delayMs = this.nextBackoffMs;
    this.nextBackoffMs = Math.min(this.nextBackoffMs * 2, MAX_BACKOFF_MS);
    this.state = 'restarting';
    this.deps.logger.warn({ delayMs }, 'worker crashed; restarting after backoff');
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      this.restarts += 1;
      this.spawn();
    }, delayMs);
  }

  private async shutdownWorker(entry: WorkerEntry): Promise<void> {
    entry.shuttingDown = true;
    entry.worker.send({ type: 'shutdown' });
    const killTimer = this.setTimer(() => {
      this.deps.logger.warn({ workerPid: entry.worker.pid }, 'worker did not stop in time; killing it');
      entry.worker.kill();
    }, this.stopTimeoutMs);
    await entry.exited;
    this.clearTimer(killTimer);
  }

  private cancelRestartTimer(): void {
    if (this.restartTimer) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
  }

  private finish(reason: FinishReason): void {
    if (this.finished) return;
    this.finished = true;
    this.state = 'stopped';
    this.cancelRestartTimer();
    this.deps.logger.info({ reason }, 'supervisor finished');
    for (const listener of this.finishListeners) listener(reason);
  }
}
