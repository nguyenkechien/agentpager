import type { AutostartTarget } from '../../platform/autostart/types.js';
import type { CliDeps, Command } from '../types.js';

export function autostartTarget(deps: CliDeps): AutostartTarget {
  return { nodePath: deps.nodePath, cliPath: deps.cliPath, workingDir: deps.platform.homedir };
}

export const autostartCommand: Command = async (args, io, deps) => {
  switch (args.positionals[0]) {
    case 'on':
      for (const message of await deps.autostart.enable(autostartTarget(deps))) io.out(message);
      return 0;
    case 'off':
      for (const message of await deps.autostart.disable()) io.out(message);
      return 0;
    case 'status': {
      const status = await deps.autostart.status();
      io.out(`Tự khởi động: ${status.enabled ? 'bật' : 'tắt'}`);
      if (status.target) io.out(`Lệnh: "${status.target.nodePath}" "${status.target.cliPath}" daemon`);
      for (const problem of status.problems) io.out(`⚠️ ${problem}`);
      return 0;
    }
    default:
      io.err('Cách dùng: agentpager autostart on|off|status');
      return 1;
  }
};
