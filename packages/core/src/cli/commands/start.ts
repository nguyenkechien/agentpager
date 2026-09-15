import type { Command } from '../types.js';
import { daemonStatus, startDaemon } from './daemonControl.js';

export const startCommand: Command = async (args, io, deps) => {
  if (args.flags.foreground !== true) return startDaemon(io, deps);

  await deps.configStore.read();
  const running = await daemonStatus(deps);
  if (running) {
    io.out(`agentpager is already running (pid ${running.pid}) — stop it before running --foreground.`);
    return 1;
  }
  io.out('agentpager is running in this terminal — Ctrl+C to stop.');
  return deps.runDaemon(true);
};
