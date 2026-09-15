import { formatLogLine } from '../../control/logFiles.js';
import type { Command } from '../types.js';

export const DEFAULT_LOG_LINES = 50;

export const logsCommand: Command = async (args, io, deps) => {
  let count = DEFAULT_LOG_LINES;
  const requested = args.flags.n;
  if (requested !== undefined) {
    if (requested === true || !/^\d+$/.test(requested) || Number(requested) < 1) {
      io.err('❌ -n needs a line count ≥ 1, e.g. agentpager logs -n 100');
      return 1;
    }
    count = Number(requested);
  }

  const lines = await deps.readLogTail(count);
  if (lines.length === 0) io.out(`No logs yet in ${deps.paths.logs}`);
  for (const line of lines) io.out(formatLogLine(line));

  if (args.flags.f === true || args.flags.follow === true) {
    const stop = await deps.followLog((line) => {
      io.out(formatLogLine(line));
    });
    await deps.waitForInterrupt();
    stop();
  }
  return 0;
};
