import { readDaemonStatus, stopDaemon, type DaemonControlDeps } from '@chiennguyen/agentpager/control';
import { ipcRequest, readDaemonInfo, type IpcCommand } from '@chiennguyen/agentpager/daemon';
import { appPaths, createAutostart, currentPlatform, defaultAutostartDeps, homeOverride } from '@chiennguyen/agentpager/platform';
import { app } from 'electron';
import { daemonCommand } from '../daemonProcess.js';
import type { MaintenanceTask } from '../launchMode.js';
import { appAutostartTarget, AutostartService } from '../services/autostartService.js';
import { createDesktopLog, type DesktopLog } from '../shell/desktopLog.js';
import { LOGIN_ITEM_ARGS } from '../shell/loginItem.js';
import { prepareUpdate, QUIT_FOR_MAINTENANCE, uninstallCleanup } from './maintenance.js';
import { writeResumeMarker } from './resumeMarker.js';

const GUI_QUIT_TIMEOUT_MS = 10_000;
const GUI_QUIT_POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Taking the single-instance lock sends QUIT_FOR_MAINTENANCE to a running window, which quits; the lock frees once
 * it has exited. After the timeout the installer's own process check closes whatever is left.
 */
async function quitGui(log: DesktopLog): Promise<void> {
  const deadline = Date.now() + GUI_QUIT_TIMEOUT_MS;
  while (!app.requestSingleInstanceLock(QUIT_FOR_MAINTENANCE)) {
    if (Date.now() >= deadline) {
      log.info('the agentpager window did not quit in time; the installer closes it');
      return;
    }
    await sleep(GUI_QUIT_POLL_MS);
  }
}

/** Runs one installer maintenance task and returns the process exit code. Details go to desktop.log. */
export async function runMaintenance(task: MaintenanceTask): Promise<number> {
  const platform = currentPlatform();
  const paths = appPaths(platform);
  const log = createDesktopLog(paths.logs);
  const control: Pick<DaemonControlDeps, 'ipc' | 'sleep' | 'now'> = {
    ipc: async (command: IpcCommand) => ipcRequest(await readDaemonInfo(paths.daemonInfo), command),
    sleep,
    now: Date.now,
  };
  const daemon = {
    readDaemonInfo: () => readDaemonInfo(paths.daemonInfo),
    readStatus: () => readDaemonStatus(control),
    stopDaemon: () => stopDaemon(control),
    execPath: process.execPath,
    platform: platform.platform,
    quitGui: () => quitGui(log),
  };
  log.info(`${task} started`, { version: app.getVersion() });
  try {
    if (task === 'prepare-update') {
      const result = await prepareUpdate({ ...daemon, writeMarker: () => writeResumeMarker(paths.root, app.getVersion(), new Date()) });
      log.info('prepare-update finished', { result });
    } else {
      const processInfo = { execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath() };
      await uninstallCleanup({
        ...daemon,
        autostart: new AutostartService({
          autostart: createAutostart(defaultAutostartDeps(paths, platform)),
          target: appAutostartTarget(daemonCommand(processInfo), platform.homedir),
          platform: platform.platform,
          homeOverride: homeOverride(platform),
        }),
        removeLoginItem: () => {
          app.setLoginItemSettings({ openAtLogin: false, args: LOGIN_ITEM_ARGS });
        },
        homeOverride: homeOverride(platform),
      });
      log.info('uninstall-cleanup finished');
    }
    return 0;
  } catch (error) {
    log.error(`${task} failed`, error);
    return 1;
  }
}
