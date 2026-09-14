import type { AutostartTarget } from '../../platform/autostart/types.js';
import { homeOverride } from '../../platform/paths.js';
import type { CliDeps, Command } from '../types.js';

/** Autostart problems are front-end neutral; the CLI adds its own fix. */
export const AUTOSTART_FIX_HINT = 'Chạy lại "agentpager autostart on" để sửa.';

export function autostartTarget(deps: CliDeps): AutostartTarget {
  return { command: deps.nodePath, args: [deps.cliPath, 'daemon'], workingDir: deps.platform.homedir, console: true };
}

/**
 * The logon task / LaunchAgent is one per user and does not carry AGENTPAGER_HOME: changing it from a separate
 * app-data folder would replace the real bot's autostart with one that runs against the default folder.
 */
export function autostartHomeProblem(deps: CliDeps): string | null {
  const home = homeOverride(deps.platform);
  if (home === null) return null;
  return `Tự khởi động là thiết lập chung của máy và không mang theo AGENTPAGER_HOME (${home}) — bỏ AGENTPAGER_HOME để bật/tắt.`;
}

export const autostartCommand: Command = async (args, io, deps) => {
  const action = args.positionals[0];
  if (action === 'on' || action === 'off') {
    const problem = autostartHomeProblem(deps);
    if (problem !== null) {
      io.err(`❌ ${problem}`);
      return 1;
    }
  }
  switch (action) {
    case 'on':
      for (const message of await deps.autostart.enable(autostartTarget(deps))) io.out(message);
      return 0;
    case 'off':
      for (const message of await deps.autostart.disable()) io.out(message);
      return 0;
    case 'status': {
      const status = await deps.autostart.status();
      io.out(`Tự khởi động: ${status.enabled ? 'bật' : 'tắt'}`);
      if (status.target) io.out(`Lệnh: ${[status.target.command, ...status.target.args].map((part) => `"${part}"`).join(' ')}`);
      for (const problem of status.problems) io.out(`⚠️ ${problem}`);
      if (status.problems.length > 0) io.out(AUTOSTART_FIX_HINT);
      return 0;
    }
    default:
      io.err('Cách dùng: agentpager autostart on|off|status');
      return 1;
  }
};
