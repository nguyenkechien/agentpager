import type { DaemonInfo } from '@chiennguyen/agentpager/daemon';

/** The running daemon was started from this very executable (so replacing or removing its files affects it). */
export function ownsDaemon(info: DaemonInfo | null, execPath: string, platform: NodeJS.Platform): boolean {
  const launcher = info?.launcher;
  if (launcher?.kind !== 'app') return false;
  return platform === 'win32' ? launcher.executable.toLowerCase() === execPath.toLowerCase() : launcher.executable === execPath;
}
