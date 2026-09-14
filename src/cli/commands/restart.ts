import type { Command } from '../types.js';
import { daemonStatus, restartDaemon, startDaemon } from './daemonControl.js';

export const restartCommand: Command = async (_args, io, deps) => {
  await deps.configStore.read();
  const running = await daemonStatus(deps);
  if (!running) return startDaemon(io, deps);
  return restartDaemon(io, deps, running);
};
