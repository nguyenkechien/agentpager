import { STOP_TIMEOUT_MS, type StopResult } from '@chiennguyen/agentpager/control';
import type { DaemonInfo, SupervisorStatus } from '@chiennguyen/agentpager/daemon';
import { z } from 'zod';
import type { AutostartService } from '../services/autostartService.js';
import { ownsDaemon } from './ownDaemon.js';

/** Sent as single-instance data by a maintenance process: the running window quits instead of showing itself. */
export const QUIT_FOR_MAINTENANCE = { command: 'quit-for-maintenance' } as const;

const quitSignalSchema = z.object({ command: z.literal(QUIT_FOR_MAINTENANCE.command) });

export function isQuitForMaintenance(data: unknown): boolean {
  return quitSignalSchema.safeParse(data).success;
}

export interface MaintenanceDaemonDeps {
  readDaemonInfo: () => Promise<DaemonInfo | null>;
  readStatus: () => Promise<SupervisorStatus | null>;
  stopDaemon: () => Promise<StopResult>;
  /** This executable: only a daemon started from it is stopped. */
  execPath: string;
  platform: NodeJS.Platform;
}

export interface PrepareUpdateDeps extends MaintenanceDaemonDeps {
  /** Makes a running agentpager window quit (it holds files open too). */
  quitGui: () => Promise<void>;
  writeMarker: () => Promise<void>;
}

export interface UninstallCleanupDeps extends MaintenanceDaemonDeps {
  quitGui: () => Promise<void>;
  autostart: Pick<AutostartService, 'get' | 'set'>;
  removeLoginItem: () => void;
  homeOverride: string | null;
}

/** Stops the daemon when it runs from this executable; `beforeStop` runs only when there is something to stop. */
async function stopOwnDaemon(deps: MaintenanceDaemonDeps, beforeStop?: () => Promise<void>): Promise<boolean> {
  if (!ownsDaemon(await deps.readDaemonInfo(), deps.execPath, deps.platform)) return false;
  if ((await deps.readStatus()) === null) return false;
  await beforeStop?.();
  const result = await deps.stopDaemon();
  if (result.kind === 'timeout') throw new Error(`agentpager chưa dừng sau ${STOP_TIMEOUT_MS / 1000} giây`);
  return result.kind === 'stopped';
}

/**
 * `--prepare-update`, run by the installer before it replaces files: the window quits, and a bot running from this
 * installation stops gracefully after leaving a marker so the new version starts it again.
 */
export async function prepareUpdate(deps: PrepareUpdateDeps): Promise<'stopped' | 'nothing_to_stop'> {
  await deps.quitGui();
  return (await stopOwnDaemon(deps, deps.writeMarker)) ? 'stopped' : 'nothing_to_stop';
}

/**
 * `--uninstall-cleanup`, run by a real uninstall: nothing machine-wide may keep pointing at the removed executable.
 * Every step runs even when stopping the bot fails; the first failure is reported afterwards.
 */
export async function uninstallCleanup(deps: UninstallCleanupDeps): Promise<void> {
  await deps.quitGui();
  let failure: Error | null = null;
  try {
    await stopOwnDaemon(deps);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  if (deps.homeOverride === null) {
    const autostart = await deps.autostart.get();
    if (autostart.enabled && autostart.ownedByThisApp) await deps.autostart.set(false);
    deps.removeLoginItem();
  }
  if (failure !== null) throw failure;
}
