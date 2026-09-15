import {
  readDaemonStatus,
  restartDaemon,
  START_TIMEOUT_MS,
  startDaemon,
  STOP_TIMEOUT_MS,
  stopDaemon,
  type DaemonControlDeps,
  type StartResult,
} from '@chiennguyen/agentpager/control';
import { IpcError, type DaemonInfo, type IpcErrorCode, type SupervisorStatus } from '@chiennguyen/agentpager/daemon';
import type { BadgeState, DaemonView } from '../../shared/api.js';
import { ApiFailure } from './results.js';

export interface DaemonServiceDeps extends DaemonControlDeps {
  readDaemonInfo: () => Promise<DaemonInfo | null>;
  logsDir: string;
}

/** An IPC failure other than "nothing is listening": something answers, but not usefully. */
export type DaemonIpcProblem = Exclude<IpcErrorCode, 'not_running'>;

function badgeOf(status: SupervisorStatus): BadgeState {
  switch (status.workerState) {
    case 'running':
      return 'running';
    case 'starting':
      return 'starting';
    case 'restarting':
      return 'restarting';
    case 'stopped':
      return status.lastError === null ? 'stopped' : 'error';
  }
}

export function toDaemonView(
  status: SupervisorStatus | null,
  info: DaemonInfo | null,
  fatalSinceStart: string | null,
  ipcProblem: DaemonIpcProblem | null,
): DaemonView {
  const launcher = info?.launcher ?? null;
  if (ipcProblem !== null) {
    return {
      // A stale daemon.json token means we lost the connection; a slow or broken answer is never "stopped".
      badge: ipcProblem === 'unauthorized' ? 'disconnected' : 'unresponsive',
      pid: info?.pid ?? null,
      startedAt: info?.startedAt ?? null,
      workerPid: null,
      restarts: 0,
      botUsername: null,
      provider: null,
      lastError: null,
      launcher,
    };
  }
  if (status === null) {
    return {
      badge: fatalSinceStart === null ? 'stopped' : 'error',
      pid: null,
      startedAt: null,
      workerPid: null,
      restarts: 0,
      botUsername: null,
      provider: null,
      lastError: fatalSinceStart,
      launcher: null,
    };
  }
  return {
    badge: badgeOf(status),
    pid: status.pid,
    startedAt: status.startedAt,
    workerPid: status.workerPid,
    restarts: status.restarts,
    botUsername: status.botUsername,
    provider: status.provider,
    lastError: status.lastError,
    launcher,
  };
}

export class DaemonService {
  /** When this app last started the bot: a fatal error logged after it explains why nothing runs. */
  private startedAt: number | null = null;

  constructor(private readonly deps: DaemonServiceDeps) {}

  async status(): Promise<DaemonView> {
    let status: SupervisorStatus | null;
    try {
      status = await readDaemonStatus(this.deps);
    } catch (error) {
      if (!(error instanceof IpcError) || error.code === 'not_running') throw error;
      return toDaemonView(null, await this.deps.readDaemonInfo(), null, error.code);
    }
    if (status === null) {
      const fatal = this.startedAt === null ? null : await this.deps.lastDaemonFatal(this.startedAt);
      return toDaemonView(null, null, fatal, null);
    }
    return toDaemonView(status, await this.deps.readDaemonInfo(), null, null);
  }

  async start(): Promise<DaemonView> {
    this.startedAt = this.deps.now();
    return this.afterStart(await startDaemon(this.deps));
  }

  async restart(): Promise<DaemonView> {
    const current = await readDaemonStatus(this.deps);
    if (current === null) return this.start();
    this.startedAt = this.deps.now();
    return this.afterStart(await restartDaemon(this.deps, current));
  }

  async stop(): Promise<DaemonView> {
    const result = await stopDaemon(this.deps);
    if (result.kind === 'timeout') {
      throw new ApiFailure({
        code: 'timeout',
        message: `agentpager did not stop after ${STOP_TIMEOUT_MS / 1000} seconds — see the logs in ${this.deps.logsDir}`,
      });
    }
    this.startedAt = null;
    return this.status();
  }

  /** Moves a bot started by agentpager cli (daemons from 0.1.x carry no launcher; they came from the cli) to this app. */
  async switchToApp(): Promise<DaemonView> {
    const info = await this.deps.readDaemonInfo();
    const current = await readDaemonStatus(this.deps);
    if (info === null || current === null) throw new ApiFailure({ code: 'not_running', message: 'The bot is not running.' });
    if (info.launcher?.kind === 'app') throw new ApiFailure({ code: 'invalid_input', message: 'The bot is already running from agentpager app.' });
    await this.stop();
    return this.start();
  }

  private afterStart(result: StartResult): Promise<DaemonView> {
    if (result.kind === 'fatal') throw new ApiFailure({ code: 'fatal', message: result.message });
    if (result.kind === 'timeout') {
      throw new ApiFailure({
        code: 'timeout',
        message: `agentpager was not ready after ${START_TIMEOUT_MS / 1000} seconds — see the logs in ${this.deps.logsDir}`,
      });
    }
    return this.status();
  }
}
