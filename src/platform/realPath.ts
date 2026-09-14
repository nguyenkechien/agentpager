import { realpathSync } from 'node:fs';

/**
 * Version managers such as fnm run node through per-shell junctions that are deleted later
 * (`fnm_multishells\<id>`); autostart and the detached daemon must record the file the link points to.
 */
export function stableExecutablePath(path: string, realpath: (path: string) => string = realpathSync): string {
  return realpath(path);
}
