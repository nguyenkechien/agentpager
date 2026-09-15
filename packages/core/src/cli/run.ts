import { ConfigError } from '../core/config/schema.js';
import { MISSING_CONFIG_MESSAGE } from '../core/config/store.js';
import { IpcError } from '../daemon/ipc.js';
import { parseArgs } from './args.js';
import { autostartCommand } from './commands/autostart.js';
import { configCommand } from './commands/config.js';
import { helpLines } from './commands/help.js';
import { logsCommand } from './commands/logs.js';
import { restartCommand } from './commands/restart.js';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { usersCommand } from './commands/users.js';
import { CliAbortError, type CliIo } from './io.js';
import type { CliDeps, Command } from './types.js';

const daemonCommand: Command = (_args, _io, deps) => deps.runDaemon(false);

const COMMANDS: Record<string, Command> = {
  setup: setupCommand,
  start: startCommand,
  stop: stopCommand,
  restart: restartCommand,
  status: statusCommand,
  logs: logsCommand,
  autostart: autostartCommand,
  config: configCommand,
  users: usersCommand,
  // Hidden: what `start` and autostart launch in the background.
  daemon: daemonCommand,
};

export async function runCli(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.version === true) {
    io.out(deps.version);
    return 0;
  }
  if (args.command === null || args.command === 'help' || args.flags.help === true || args.flags.h === true) {
    for (const line of helpLines(deps.version)) io.out(line);
    return 0;
  }

  const command = COMMANDS[args.command];
  if (!command) {
    io.err(`Unknown command: ${args.command}`);
    for (const line of helpLines(deps.version)) io.err(line);
    return 1;
  }

  try {
    return await command(args, io, deps);
  } catch (error) {
    if (error instanceof ConfigError) {
      if (error.issues.length === 1 && error.issues[0] === MISSING_CONFIG_MESSAGE) {
        io.err(MISSING_CONFIG_MESSAGE);
      } else {
        io.err('Invalid config:');
        for (const issue of error.issues) io.err(`- ${issue}`);
      }
      return 1;
    }
    if (error instanceof IpcError) {
      io.err(`❌ ${error.message}${error.code === 'timeout' ? ` — see the logs in ${deps.paths.logs}` : ''}`);
      return 1;
    }
    if (error instanceof CliAbortError) {
      io.err('Cancelled.');
      return 130;
    }
    throw error;
  }
}
