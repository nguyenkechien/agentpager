import {
  notifyUsersChanged as notifyDaemon,
  pollDaemonStatus,
  readDaemonStatus,
  restartDaemon as restartWorker,
  START_TIMEOUT_MS,
  startDaemon as startWorker,
  STOP_TIMEOUT_MS,
  stopDaemon as stopWorker,
  type DaemonControlDeps,
  type WorkerResult,
} from '../../control/daemon.js';
import type { SupervisorStatus } from '../../daemon/supervisor.js';
import type { CliIo } from '../io.js';
import type { CliDeps } from '../types.js';

export const RESTART_HINT = 'Chạy "agentpager restart" để áp dụng.';

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Null when no daemon answers; other IPC failures propagate. */
export function daemonStatus(deps: CliDeps): Promise<SupervisorStatus | null> {
  return readDaemonStatus(deps);
}

function controlDeps(deps: CliDeps): DaemonControlDeps {
  return { ipc: deps.ipc, spawnDaemon: deps.spawnDaemon, lastDaemonFatal: deps.lastDaemonFatal, sleep: deps.sleep, now: deps.now };
}

function reportWorker(io: CliIo, deps: CliDeps, result: WorkerResult): number {
  switch (result.kind) {
    case 'running':
      io.out(`✅ agentpager đang chạy · bot @${result.status.botUsername ?? '?'} · pid ${result.status.pid}`);
      return 0;
    case 'fatal':
      io.err(`❌ ${result.message}`);
      return 1;
    case 'timeout':
      io.err(`❌ agentpager chưa sẵn sàng sau ${START_TIMEOUT_MS / 1000} giây — xem log trong ${deps.paths.logs}`);
      return 1;
  }
}

export async function startDaemon(io: CliIo, deps: CliDeps): Promise<number> {
  // Fail with the configuration problems here instead of inside a detached process.
  await deps.configStore.read();
  const result = await startWorker(controlDeps(deps));
  if (result.kind === 'already_running') {
    io.out(`agentpager đang chạy (pid ${result.status.pid})`);
    return 0;
  }
  return reportWorker(io, deps, result);
}

export async function restartDaemon(io: CliIo, deps: CliDeps, previous: SupervisorStatus): Promise<number> {
  const result = await restartWorker(controlDeps(deps), previous, () => {
    io.out('🔄 Đang khởi động lại…');
  });
  return reportWorker(io, deps, result);
}

export async function stopDaemon(io: CliIo, deps: CliDeps): Promise<number> {
  const result = await stopWorker(controlDeps(deps));
  switch (result.kind) {
    case 'not_running':
      io.out('agentpager không chạy');
      return 0;
    case 'stopped':
      io.out('⏹ Đã dừng agentpager.');
      return 0;
    case 'timeout':
      io.err(`❌ agentpager chưa dừng sau ${STOP_TIMEOUT_MS / 1000} giây — xem log trong ${deps.paths.logs}`);
      return 1;
  }
}

/** Tells a running bot to re-read allowed users; a stopped daemon needs nothing. */
export async function notifyUsersChanged(io: CliIo, deps: CliDeps): Promise<void> {
  const result = await notifyDaemon(deps);
  if (result.kind === 'reloaded') io.out('Đã cập nhật danh sách cho bot đang chạy.');
  if (result.kind === 'failed') io.err(`⚠️ Không báo được cho daemon (${result.message}) — chạy "agentpager restart".`);
}

export async function printRestartHintIfRunning(io: CliIo, deps: CliDeps): Promise<void> {
  // A daemon that answers with an error is still running.
  if ((await pollDaemonStatus(deps)) !== null) io.out(RESTART_HINT);
}
