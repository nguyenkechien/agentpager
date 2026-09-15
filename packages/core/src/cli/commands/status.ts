import { ConfigError, maskToken, type AgentpagerConfig, type AllowedUser } from '../../core/config/schema.js';
import { IpcError } from '../../daemon/ipc.js';
import type { SupervisorStatus, WorkerState } from '../../daemon/supervisor.js';
import { plural } from '../../util/time.js';
import type { Command } from '../types.js';
import { AUTOSTART_FIX_HINT } from './autostart.js';
import { daemonStatus, messageOf } from './daemonControl.js';

const WORKER_STATE: Record<WorkerState, string> = {
  starting: 'starting',
  running: 'running',
  restarting: 'restarting',
  stopped: 'stopped',
};

function describeUser(user: AllowedUser): string {
  return `@${user.username} (${user.userId === null ? 'pending pairing' : 'paired'})`;
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
      `Daemon: running · pid ${daemon.pid} · worker ${WORKER_STATE[daemon.workerState]} · bot @${daemon.botUsername ?? '?'} · restarted ${plural(daemon.restarts, 'time')}`,
    );
    if (daemon.lastError !== null) io.out(`  Last error: ${daemon.lastError}`);
    if (daemon.activeTurns !== null && daemon.queuedInputs !== null) {
      const idle = daemon.activeTurns === 0 && daemon.queuedInputs === 0;
      io.out(`  Work: ${idle ? 'idle' : `running ${plural(daemon.activeTurns, 'turn')}, ${plural(daemon.queuedInputs, 'queued message')}`}`);
    }
  } else {
    io.out(`Daemon: ${daemonProblem ?? 'not running'}`);
  }

  let config: AgentpagerConfig | null = null;
  try {
    config = await deps.configStore.read();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.out(`Config: ${error.issues.join('; ')}`);
  }
  if (config) {
    const provider = config.agent.provider;
    const entry = deps.catalog.find((candidate) => candidate.id === provider);
    const detection = entry ? await entry.detect({ executable: config.agent.executable }) : null;
    const binary = detection ? ` · ${detection.executable ?? 'bundled with the SDK'}${detection.version ? ` (${detection.version})` : ''}` : '';
    io.out(`Agent: ${entry?.displayName ?? provider}${binary}`);
    for (const problem of detection?.problems ?? []) io.out(`  ⚠️ ${problem}`);
    io.out(`Projects: ${config.projectsRoot}`);
    io.out(`Bot token: ${maskToken(config.telegram.botToken)}`);
    io.out(`Users: ${config.allowedUsers.map(describeUser).join(', ')}`);
  }

  try {
    const autostart = await deps.autostart.status();
    io.out(`Autostart: ${autostart.enabled ? 'on' : 'off'}`);
    for (const problem of autostart.problems) io.out(`  ⚠️ ${problem}`);
    if (autostart.problems.length > 0) io.out(`  ${AUTOSTART_FIX_HINT}`);
  } catch (error) {
    // Shown as a status line: e.g. autostart is not available on this platform.
    io.out(`Autostart: ${messageOf(error)}`);
  }

  io.out(`Config file: ${deps.paths.config}`);
  io.out(`Log: ${deps.paths.logs}`);
  return config ? 0 : 1;
};
