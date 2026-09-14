import { z } from 'zod';
import { IpcError, type IpcCommand, type IpcErrorCode } from '../daemon/ipc.js';
import type { SupervisorStatus } from '../daemon/supervisor.js';

export const START_TIMEOUT_MS = 20_000;
export const STOP_TIMEOUT_MS = 25_000;
export const POLL_INTERVAL_MS = 500;

export interface DaemonControlDeps {
  ipc: (command: IpcCommand) => Promise<unknown>;
  /** Starts a detached daemon process; the caller decides which executable runs it. */
  spawnDaemon: () => void;
  /** The latest fatal worker error the supervisor logged at or after `sinceMs`. */
  lastDaemonFatal: (sinceMs: number) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type WorkerResult =
  | { kind: 'running'; status: SupervisorStatus }
  | { kind: 'fatal'; message: string }
  | { kind: 'timeout' };

export type StartResult = { kind: 'already_running'; status: SupervisorStatus } | WorkerResult;

export type StopResult = { kind: 'stopped' } | { kind: 'not_running' } | { kind: 'timeout' };

export type UsersChangedResult =
  | { kind: 'reloaded' }
  | { kind: 'not_running' }
  | { kind: 'failed'; code: IpcErrorCode; message: string };

const statusSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
  workerPid: z.number().nullable(),
  workerState: z.enum(['starting', 'running', 'restarting', 'stopped']),
  restarts: z.number(),
  botUsername: z.string().nullable(),
  provider: z.string().nullable(),
  lastError: z.string().nullable(),
});

/** Null when no daemon answers; other IPC failures propagate. */
export async function readDaemonStatus(deps: Pick<DaemonControlDeps, 'ipc'>): Promise<SupervisorStatus | null> {
  try {
    return statusSchema.parse(await deps.ipc('status'));
  } catch (error) {
    if (error instanceof IpcError && error.code === 'not_running') return null;
    throw error;
  }
}

/** While a daemon starts or stops, a failed status request just means "ask again". */
export async function pollDaemonStatus(deps: Pick<DaemonControlDeps, 'ipc'>): Promise<SupervisorStatus | null | 'unavailable'> {
  try {
    return await readDaemonStatus(deps);
  } catch (error) {
    if (error instanceof IpcError) return 'unavailable';
    throw error;
  }
}

async function waitForWorker(
  deps: DaemonControlDeps,
  sinceMs: number,
  isExpectedWorker: (status: SupervisorStatus) => boolean,
): Promise<WorkerResult> {
  const deadline = deps.now() + START_TIMEOUT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    const status = await pollDaemonStatus(deps);
    if (status !== null && status !== 'unavailable' && status.workerState === 'running' && isExpectedWorker(status)) {
      return { kind: 'running', status };
    }
    const fatal = await deps.lastDaemonFatal(sinceMs);
    if (fatal !== null) return { kind: 'fatal', message: fatal };
  }
  return { kind: 'timeout' };
}

export async function startDaemon(deps: DaemonControlDeps): Promise<StartResult> {
  const running = await readDaemonStatus(deps);
  if (running) return { kind: 'already_running', status: running };
  const since = deps.now();
  deps.spawnDaemon();
  return waitForWorker(deps, since, () => true);
}

/** `onRequested` runs once the daemon has accepted the restart, before waiting for the new worker. */
export async function restartDaemon(
  deps: DaemonControlDeps,
  previous: SupervisorStatus,
  onRequested?: () => void,
): Promise<WorkerResult> {
  const since = deps.now();
  await deps.ipc('restart');
  onRequested?.();
  return waitForWorker(deps, since, (status) => status.workerPid !== previous.workerPid);
}

export async function stopDaemon(deps: Pick<DaemonControlDeps, 'ipc' | 'sleep' | 'now'>): Promise<StopResult> {
  try {
    await deps.ipc('stop');
  } catch (error) {
    if (error instanceof IpcError && error.code === 'not_running') return { kind: 'not_running' };
    throw error;
  }
  const deadline = deps.now() + STOP_TIMEOUT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    if ((await pollDaemonStatus(deps)) === null) return { kind: 'stopped' };
  }
  return { kind: 'timeout' };
}

/** Tells a running bot to re-read allowed users; a stopped daemon needs nothing. */
export async function notifyUsersChanged(deps: Pick<DaemonControlDeps, 'ipc'>): Promise<UsersChangedResult> {
  try {
    await deps.ipc('reload-users');
    return { kind: 'reloaded' };
  } catch (error) {
    if (!(error instanceof IpcError)) throw error;
    if (error.code === 'not_running') return { kind: 'not_running' };
    return { kind: 'failed', code: error.code, message: error.message };
  }
}
