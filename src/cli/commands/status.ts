import { ConfigError, maskToken, type AgentpagerConfig, type AllowedUser } from '../../core/config/schema.js';
import { IpcError } from '../../daemon/ipc.js';
import type { SupervisorStatus, WorkerState } from '../../daemon/supervisor.js';
import type { Command } from '../types.js';
import { daemonStatus, messageOf } from './daemonControl.js';

const WORKER_STATE: Record<WorkerState, string> = {
  starting: 'đang khởi động',
  running: 'đang chạy',
  restarting: 'đang khởi động lại',
  stopped: 'đã dừng',
};

function describeUser(user: AllowedUser): string {
  return `@${user.username} (${user.userId === null ? 'chờ ghép' : 'đã ghép'})`;
}

export const statusCommand: Command = async (_args, io, deps) => {
  io.out(`agentpager ${deps.version}`);

  let daemon: SupervisorStatus | null = null;
  let daemonProblem: string | null = null;
  try {
    daemon = await daemonStatus(deps);
  } catch (error) {
    if (!(error instanceof IpcError)) throw error;
    daemonProblem = error.message;
  }
  if (daemon) {
    io.out(
      `Daemon: đang chạy · pid ${daemon.pid} · worker ${WORKER_STATE[daemon.workerState]} · bot @${daemon.botUsername ?? '?'} · khởi động lại ${daemon.restarts} lần`,
    );
    if (daemon.lastError !== null) io.out(`  Lỗi gần nhất: ${daemon.lastError}`);
  } else {
    io.out(`Daemon: ${daemonProblem ?? 'không chạy'}`);
  }

  let config: AgentpagerConfig | null = null;
  try {
    config = await deps.configStore.read();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.out(`Cấu hình: ${error.issues.join('; ')}`);
  }
  if (config) {
    const provider = config.agent.provider;
    const entry = deps.catalog.find((candidate) => candidate.id === provider);
    const detection = entry ? await entry.detect({ executable: config.agent.executable }) : null;
    const binary = detection ? ` · ${detection.executable ?? 'bản đi kèm SDK'}${detection.version ? ` (${detection.version})` : ''}` : '';
    io.out(`Agent: ${entry?.displayName ?? provider}${binary}`);
    for (const problem of detection?.problems ?? []) io.out(`  ⚠️ ${problem}`);
    io.out(`Projects: ${config.projectsRoot}`);
    io.out(`Bot token: ${maskToken(config.telegram.botToken)}`);
    io.out(`Người dùng: ${config.allowedUsers.map(describeUser).join(', ')}`);
  }

  try {
    const autostart = await deps.autostart.status();
    io.out(`Tự khởi động: ${autostart.enabled ? 'bật' : 'tắt'}`);
    for (const problem of autostart.problems) io.out(`  ⚠️ ${problem}`);
  } catch (error) {
    // Shown as a status line: e.g. autostart is not available on this platform.
    io.out(`Tự khởi động: ${messageOf(error)}`);
  }

  io.out(`File cấu hình: ${deps.paths.config}`);
  io.out(`Log: ${deps.paths.logs}`);
  return config ? 0 : 1;
};
