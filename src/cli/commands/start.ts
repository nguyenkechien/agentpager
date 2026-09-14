import type { Command } from '../types.js';
import { daemonStatus, startDaemon } from './daemonControl.js';

export const startCommand: Command = async (args, io, deps) => {
  if (args.flags.foreground !== true) return startDaemon(io, deps);

  await deps.configStore.read();
  const running = await daemonStatus(deps);
  if (running) {
    io.out(`agentpager đang chạy (pid ${running.pid}) — dừng nó trước khi chạy --foreground.`);
    return 1;
  }
  io.out('agentpager chạy trong terminal này — Ctrl+C để dừng.');
  return deps.runDaemon(true);
};
