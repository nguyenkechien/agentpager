import { z } from 'zod';
import { IpcError } from '../../daemon/ipc.js';
import type { SupervisorStatus } from '../../daemon/supervisor.js';
import type { CliIo } from '../io.js';
import type { CliDeps } from '../types.js';

export const START_TIMEOUT_MS = 20_000;
export const STOP_TIMEOUT_MS = 25_000;
export const POLL_INTERVAL_MS = 500;
export const RESTART_HINT = 'Chạy "agentpager restart" để áp dụng.';

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

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Null when no daemon answers; other IPC failures propagate. */
export async function daemonStatus(deps: CliDeps): Promise<SupervisorStatus | null> {
  try {
    return statusSchema.parse(await deps.ipc('status'));
  } catch (error) {
    if (error instanceof IpcError && error.code === 'not_running') return null;
    throw error;
  }
}

/** While a daemon starts or stops, a failed status request just means "ask again". */
async function pollStatus(deps: CliDeps): Promise<SupervisorStatus | null | 'unavailable'> {
  try {
    return await daemonStatus(deps);
  } catch (error) {
    if (error instanceof IpcError) return 'unavailable';
    throw error;
  }
}

async function waitForWorker(
  io: CliIo,
  deps: CliDeps,
  sinceMs: number,
  isExpectedWorker: (status: SupervisorStatus) => boolean,
): Promise<number> {
  const deadline = deps.now() + START_TIMEOUT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    const status = await pollStatus(deps);
    if (status !== null && status !== 'unavailable' && status.workerState === 'running' && isExpectedWorker(status)) {
      io.out(`✅ agentpager đang chạy · bot @${status.botUsername ?? '?'} · pid ${status.pid}`);
      return 0;
    }
    const fatal = await deps.lastDaemonFatal(sinceMs);
    if (fatal !== null) {
      io.err(`❌ ${fatal}`);
      return 1;
    }
  }
  io.err(`❌ agentpager chưa sẵn sàng sau ${START_TIMEOUT_MS / 1000} giây — xem log trong ${deps.paths.logs}`);
  return 1;
}

export async function startDaemon(io: CliIo, deps: CliDeps): Promise<number> {
  // Fail with the configuration problems here instead of inside a detached process.
  await deps.configStore.read();
  const running = await daemonStatus(deps);
  if (running) {
    io.out(`agentpager đang chạy (pid ${running.pid})`);
    return 0;
  }
  const since = deps.now();
  deps.spawnDaemon();
  return waitForWorker(io, deps, since, () => true);
}

export async function restartDaemon(io: CliIo, deps: CliDeps, previous: SupervisorStatus): Promise<number> {
  const since = deps.now();
  await deps.ipc('restart');
  io.out('🔄 Đang khởi động lại…');
  return waitForWorker(io, deps, since, (status) => status.workerPid !== previous.workerPid);
}

export async function stopDaemon(io: CliIo, deps: CliDeps): Promise<number> {
  try {
    await deps.ipc('stop');
  } catch (error) {
    if (error instanceof IpcError && error.code === 'not_running') {
      io.out('agentpager không chạy');
      return 0;
    }
    throw error;
  }
  const deadline = deps.now() + STOP_TIMEOUT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    if ((await pollStatus(deps)) === null) {
      io.out('⏹ Đã dừng agentpager.');
      return 0;
    }
  }
  io.err(`❌ agentpager chưa dừng sau ${STOP_TIMEOUT_MS / 1000} giây — xem log trong ${deps.paths.logs}`);
  return 1;
}

/** Tells a running bot to re-read allowed users; a stopped daemon needs nothing. */
export async function notifyUsersChanged(io: CliIo, deps: CliDeps): Promise<void> {
  try {
    await deps.ipc('reload-users');
    io.out('Đã cập nhật danh sách cho bot đang chạy.');
  } catch (error) {
    if (!(error instanceof IpcError)) throw error;
    if (error.code === 'not_running') return;
    io.err(`⚠️ Không báo được cho daemon (${error.message}) — chạy "agentpager restart".`);
  }
}

export async function printRestartHintIfRunning(io: CliIo, deps: CliDeps): Promise<void> {
  if ((await pollStatus(deps)) !== null) io.out(RESTART_HINT);
}
