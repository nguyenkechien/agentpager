import { existsSync, mkdirSync, readFileSync, watch as watchFolder } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ConfigStore } from '@chiennguyen/agentpager/config';
import {
  followLog,
  followLogFile,
  lastDaemonFatal,
  notifyUsersChanged,
  readDaemonStatus,
  readLogFileTail,
  readLogTail,
  stopDaemon,
  supervisorLogFile,
  type StopResult,
} from '@chiennguyen/agentpager/control';
import { ipcRequest, readDaemonInfo, type DaemonInfo, type IpcCommand, type SupervisorStatus } from '@chiennguyen/agentpager/daemon';
import {
  appPaths,
  createAutostart,
  currentPlatform,
  defaultAutostartDeps,
  homeOverride,
  type AppPaths,
  type PlatformInfo,
} from '@chiennguyen/agentpager/platform';
import { providerCatalog } from '@chiennguyen/agentpager/providers';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
  type OpenDialogOptions,
  type RenderProcessGoneDetails,
} from 'electron';
import electronUpdater from 'electron-updater';
import type { DaemonView } from '../../shared/api.js';
import { EVENTS } from '../../shared/channels.js';
import { homeOverrideNote } from '../../shared/labels.js';
import { daemonCommand, spawnAppDaemon, type AppProcessInfo } from '../daemonProcess.js';
import { registerHandlers } from '../ipc/handlers.js';
import { watchConfig } from '../live/configWatcher.js';
import { LogSubscriptions, type LogReaders } from '../live/logStream.js';
import { StatusPoller } from '../live/statusPoller.js';
import { createMainHandlers } from '../mainHandlers.js';
import { AgentService } from '../services/agentService.js';
import { appAutostartTarget, AutostartService } from '../services/autostartService.js';
import { ConfigService } from '../services/configService.js';
import { DaemonService } from '../services/daemonService.js';
import { ApiFailure, toApiError } from '../services/results.js';
import { checkTokenWithTelegram } from '../services/telegramCheck.js';
import { isQuitForMaintenance, uninstallCleanup } from '../maintenance/maintenance.js';
import { ownsDaemon } from '../maintenance/ownDaemon.js';
import { resumeAfterUpdate } from '../maintenance/resumeAfterUpdate.js';
import { consumeResumeMarker, writeResumeMarker } from '../maintenance/resumeMarker.js';
import { createMacReleaseSource } from '../update/macReleaseSource.js';
import { startSchedule } from '../update/schedule.js';
import type { UpdateSource } from '../update/source.js';
import { UpdateService } from '../update/updateService.js';
import { createWindowsSource } from '../update/windowsSource.js';
import { createDesktopLog, type DesktopLog } from './desktopLog.js';
import { DESKTOP_STATE_FILE, readDesktopState, updateDesktopState } from './desktopState.js';
import { macAppBundlePath, shouldOfferMove } from './macLocation.js';
import { LOGIN_ITEM_ARGS } from './loginItem.js';
import { trayModel, type TrayAction, type TrayColor } from './trayModel.js';
import { trayImageFile, trayTheme, type TrayTheme } from './trayIcon.js';
import { isTrustedRendererUrl, type RendererLocation } from './trustedUrl.js';

export const APP_USER_MODEL_ID = 'io.github.nguyenkechien.agentpager';

export interface AppShellOptions {
  hidden: boolean;
}

interface DaemonControl {
  readDaemonInfo: () => Promise<DaemonInfo | null>;
  readStatus: () => Promise<SupervisorStatus | null>;
  stopDaemon: () => Promise<StopResult>;
}

interface Services {
  homeOverride: string | null;
  config: ConfigService;
  daemon: DaemonService;
  daemonControl: DaemonControl;
  autostart: AutostartService;
  agent: AgentService;
  update: UpdateService;
  logReaders: LogReaders;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await net.fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentpager-app' } });
  if (!response.ok) throw new Error(`GitHub trả về ${String(response.status)}`);
  return response.json();
}

/** Updates run only in an installed build, and never for an AGENTPAGER_HOME folder (tests, experiments). */
function createUpdateSource(log: DesktopLog, home: string | null): { source: UpdateSource | null; reason: 'development' | 'home_override' } {
  if (!app.isPackaged) return { source: null, reason: 'development' };
  if (home !== null) return { source: null, reason: 'home_override' };
  if (process.platform === 'win32') return { source: createWindowsSource(electronUpdater.autoUpdater, log), reason: 'development' };
  if (process.platform === 'darwin') {
    return { source: createMacReleaseSource({ fetchJson, currentVersion: app.getVersion(), arch: process.arch }), reason: 'development' };
  }
  return { source: null, reason: 'development' };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function createServices(paths: AppPaths, platform: PlatformInfo, processInfo: AppProcessInfo, log: DesktopLog): Services {
  const catalog = providerCatalog;
  const store = new ConfigStore(paths.config, { platform: platform.platform, catalog });
  const ipc = async (command: IpcCommand): Promise<unknown> => ipcRequest(await readDaemonInfo(paths.daemonInfo), command);
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  const control = { ipc, sleep, now: () => Date.now() };
  const daemonControl: DaemonControl = {
    readDaemonInfo: () => readDaemonInfo(paths.daemonInfo),
    readStatus: () => readDaemonStatus(control),
    stopDaemon: () => stopDaemon(control),
  };
  const home = homeOverride(platform);
  const updates = createUpdateSource(log, home);
  return {
    homeOverride: home,
    daemonControl,
    update: new UpdateService({
      source: updates.source,
      disabledReason: updates.reason,
      currentVersion: app.getVersion(),
      readDaemon: async () => ({ info: await daemonControl.readDaemonInfo(), status: await daemonControl.readStatus() }),
      ownsDaemon: (info) => ownsDaemon(info, processInfo.execPath, platform.platform),
      stopDaemon: daemonControl.stopDaemon,
      writeMarker: () => writeResumeMarker(paths.root, app.getVersion(), new Date()),
      openExternal: (url) => shell.openExternal(url),
      now: () => new Date(),
      log,
    }),
    config: new ConfigService({
      store,
      catalog,
      readText: readTextOrNull,
      pathExists: (path) => Promise.resolve(existsSync(path)),
      checkToken: (token) => checkTokenWithTelegram(token),
      notifyUsersChanged: () => notifyUsersChanged({ ipc }),
      platform: platform.platform,
      homedir: platform.homedir,
    }),
    daemon: new DaemonService({
      ipc,
      spawnDaemon: () => {
        spawnAppDaemon(processInfo, paths.root, platform.homedir);
      },
      lastDaemonFatal: (sinceMs) => lastDaemonFatal(paths.logs, sinceMs),
      sleep,
      now: () => Date.now(),
      readDaemonInfo: () => readDaemonInfo(paths.daemonInfo),
      logsDir: paths.logs,
    }),
    autostart: new AutostartService({
      autostart: createAutostart(defaultAutostartDeps(paths, platform)),
      target: appAutostartTarget(daemonCommand(processInfo), platform.homedir),
      platform: platform.platform,
      homeOverride: home,
    }),
    agent: new AgentService(catalog),
    logReaders: {
      readTail: async (source, lines) =>
        source === 'worker' ? readLogTail(paths.logs, lines) : readLogFileTail(await supervisorLogFile(paths.logs), lines),
      follow: (source, onLine) =>
        source === 'worker' ? followLog(paths.logs, onLine) : followLogFile(() => supervisorLogFile(paths.logs), onLine),
    },
  };
}

/** The generated PNGs live in the app folder (inside app.asar when packaged). */
function trayImage(theme: TrayTheme, color: TrayColor): NativeImage {
  const appPath = app.getAppPath();
  const file = trayImageFile(theme, color, 1);
  const image = nativeImage.createFromPath(join(appPath, file));
  if (image.isEmpty()) throw new Error(`Thiếu icon khay ${file} trong ${appPath}`);
  image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(join(appPath, trayImageFile(theme, color, 2))) });
  return image;
}

function currentTrayTheme(): TrayTheme {
  return trayTheme(process.platform, nativeTheme);
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

class AppShell {
  private window: BrowserWindow | null = null;
  private tray: Tray | null = null;
  /** The last daemon view drawn in the tray, redrawn when the taskbar or menu bar theme changes. */
  private lastView: DaemonView | null = null;
  private quitting = false;
  private stopUpdateChecks: (() => void) | null = null;
  private rendererCrashes = 0;
  private lastPollError: string | null = null;
  private readonly poller: StatusPoller;
  private readonly logs: LogSubscriptions;
  private configWatcher: { close: () => void } | null = null;

  constructor(
    private readonly paths: AppPaths,
    private readonly services: Services,
    private readonly log: DesktopLog,
  ) {
    this.poller = new StatusPoller({
      read: () => services.daemon.status(),
      onChange: (view) => {
        this.renderTray(view);
        this.window?.webContents.send(EVENTS.status, view);
        services.update.onDaemonStatus();
      },
      onError: (error) => {
        // Log a persistent failure once, not every 2 seconds.
        const message = messageOf(error);
        if (message === this.lastPollError) return;
        this.lastPollError = message;
        log.error('status poll failed', error);
      },
    });
    this.logs = new LogSubscriptions(services.logReaders, (error) => {
      log.error('log view failed', error);
    });
  }

  start(hidden: boolean): void {
    registerHandlers(
      ipcMain,
      createMainHandlers({
        config: this.services.config,
        daemon: this.services.daemon,
        autostart: this.services.autostart,
        agent: this.services.agent,
        loginItem: {
          get: () => app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }).openAtLogin,
          set: (enabled) => {
            const home = this.services.homeOverride;
            if (home !== null) throw new ApiFailure({ code: 'invalid_input', message: homeOverrideNote(home) });
            app.setLoginItemSettings({ openAtLogin: enabled, args: LOGIN_ITEM_ARGS });
            return app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }).openAtLogin;
          },
        },
        dialogs: {
          pickFolder: (defaultPath) => this.pick({ properties: ['openDirectory'], defaultPath: defaultPath ?? undefined }),
          pickExecutable: (defaultPath) =>
            this.pick({
              properties: ['openFile'],
              defaultPath: defaultPath ?? undefined,
              filters:
                process.platform === 'win32'
                  ? [
                      { name: 'Chương trình', extensions: ['exe', 'cmd'] },
                      { name: 'Tất cả file', extensions: ['*'] },
                    ]
                  : [],
            }),
        },
        shell: {
          openLogFolder: async () => {
            mkdirSync(this.paths.logs, { recursive: true });
            await this.openPath(this.paths.logs);
          },
          openConfigFile: async () => {
            if (!existsSync(this.paths.config)) {
              throw new ApiFailure({ code: 'missing_config', message: `Chưa có file cấu hình ${this.paths.config}.` });
            }
            await this.openPath(this.paths.config);
          },
        },
        logs: this.logs,
        update: this.services.update,
        appInfo: () => ({ homeOverride: this.services.homeOverride, platform: process.platform, version: app.getVersion() }),
        appUninstall: () => this.uninstallOnMac(),
        refreshStatus: () => {
          this.refreshStatus();
        },
      }),
      (url) => isTrustedRendererUrl(url, this.rendererLocation()),
    );

    this.tray = new Tray(trayImage(currentTrayTheme(), 'grey'));
    this.tray.on('click', () => {
      this.showWindow();
    });
    this.renderTray(null);
    nativeTheme.on('updated', () => {
      this.renderTray(this.lastView);
    });
    this.poller.start();
    this.watchConfigFile();
    this.services.update.onChange((view) => {
      this.renderTray(this.lastView);
      this.window?.webContents.send(EVENTS.update, view);
    });
    this.services.update.onBeforeInstall(() => {
      this.quitting = true;
    });
    this.stopUpdateChecks = startSchedule(
      () => this.services.update.check(),
      (error) => {
        this.log.error('update check failed', error);
      },
    );

    app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
      if (isQuitForMaintenance(additionalData)) {
        // The installer is about to replace or remove this app's files.
        this.log.info('quitting for the installer');
        this.quitting = true;
        app.quit();
        return;
      }
      this.showWindow();
    });
    app.on('activate', () => {
      this.showWindow();
    });
    app.on('before-quit', () => {
      this.quitting = true;
      this.poller.stop();
      this.stopUpdateChecks?.();
      this.configWatcher?.close();
    });

    if (hidden) {
      if (process.platform === 'darwin') app.dock?.hide();
    } else {
      this.showWindow();
    }
  }

  private rendererLocation(): RendererLocation {
    return {
      devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
      indexFile: join(import.meta.dirname, '../renderer/index.html'),
    };
  }

  private showWindow(): void {
    const window = this.window ?? this.createWindow();
    if (process.platform === 'darwin') void app.dock?.show();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: 'agentpager',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      this.onRendererGone(details);
    });
    window.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.hideWindow();
    });
    this.load(window);
    this.window = window;
    return window;
  }

  private load(window: BrowserWindow): void {
    const { devServerUrl, indexFile } = this.rendererLocation();
    const loading = devServerUrl === undefined ? window.loadFile(indexFile) : window.loadURL(devServerUrl);
    loading.catch((error: unknown) => {
      this.log.error('renderer failed to load', error);
    });
  }

  private hideWindow(): void {
    const window = this.window;
    if (!window) return;
    window.hide();
    this.logs.unsubscribeSender(window.webContents.id);
    if (process.platform === 'darwin') app.dock?.hide();
    this.showTrayNoticeOnce();
  }

  private showTrayNoticeOnce(): void {
    const file = join(this.paths.root, DESKTOP_STATE_FILE);
    try {
      if (readDesktopState(file).trayNoticeShownAt !== undefined) return;
      notify('agentpager vẫn chạy trong khay', 'Bot vẫn hoạt động. Mở lại từ icon agentpager; "Thoát app" chỉ đóng app, bot vẫn chạy.');
      updateDesktopState(file, { trayNoticeShownAt: new Date().toISOString() });
    } catch (error) {
      // Worst case the notice shows again next time.
      this.log.error('could not remember the tray notice', error);
    }
  }

  /** macOS has no uninstaller: undo what points at this app, then leave dragging it to the Trash to the user. */
  private async uninstallOnMac(): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new ApiFailure({ code: 'invalid_input', message: 'Trên Windows, gỡ agentpager trong Settings → Apps → Installed apps.' });
    }
    const bundle = macAppBundlePath(process.execPath);
    if (bundle === null) throw new ApiFailure({ code: 'invalid_input', message: 'Chỉ gỡ được agentpager đã cài (agentpager.app).' });
    await uninstallCleanup({
      ...this.services.daemonControl,
      execPath: process.execPath,
      platform: process.platform,
      quitGui: () => Promise.resolve(),
      autostart: this.services.autostart,
      removeLoginItem: () => {
        app.setLoginItemSettings({ openAtLogin: false, args: LOGIN_ITEM_ARGS });
      },
      homeOverride: this.services.homeOverride,
    });
    this.log.info('uninstall cleanup done; waiting for the app to be moved to the Trash');
    shell.showItemInFolder(bundle);
    notify('Gỡ agentpager', 'Kéo agentpager vào Thùng rác để gỡ xong. Cấu hình và log của bot vẫn được giữ lại.');
    // Answer the window first, then quit.
    setTimeout(() => {
      this.quitting = true;
      app.quit();
    }, 1_000);
  }

  private updateFromTray(): void {
    this.services.update.install('ask').then(
      (result) => {
        if (result.kind === 'busy' || result.kind === 'busy_unknown') {
          this.showWindow();
          notify('agentpager: agent đang bận', 'Chọn "Cập nhật khi rảnh" hoặc "Cập nhật ngay" trong cửa sổ agentpager.');
        }
      },
      (error: unknown) => {
        notify('agentpager: cập nhật không thành công', toApiError(error).message);
        this.log.error('tray update failed', error);
      },
    );
  }

  private onRendererGone(details: RenderProcessGoneDetails): void {
    this.log.error('renderer process gone', new Error(`${details.reason} (exit code ${String(details.exitCode)})`));
    const window = this.window;
    if (!window || details.reason === 'clean-exit') return;
    this.logs.unsubscribeSender(window.webContents.id);
    this.rendererCrashes += 1;
    if (this.rendererCrashes === 1) {
      this.load(window);
      return;
    }
    dialog.showErrorBox(
      'agentpager',
      'Giao diện agentpager lại bị lỗi nên không tự tải lại nữa. Bot không bị ảnh hưởng. Hãy thoát app rồi mở lại; chi tiết trong desktop.log.',
    );
  }

  private renderTray(view: DaemonView | null): void {
    const tray = this.tray;
    if (!tray) return;
    this.lastView = view;
    const model = trayModel(view, this.services.update.view());
    tray.setImage(trayImage(currentTrayTheme(), model.color));
    tray.setToolTip(model.tooltip);
    const items: MenuItemConstructorOptions[] = [{ label: model.statusLine, enabled: false }, { type: 'separator' }];
    for (const item of model.items) {
      if (item.action === 'quit') items.push({ type: 'separator' });
      items.push({
        label: item.label,
        enabled: item.enabled,
        click: () => {
          this.onTrayAction(item.action);
        },
      });
    }
    tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  private onTrayAction(action: TrayAction): void {
    switch (action) {
      case 'open':
        this.showWindow();
        return;
      case 'quit':
        app.quit();
        return;
      case 'start':
        this.runDaemonAction('Start', () => this.services.daemon.start());
        return;
      case 'stop':
        this.runDaemonAction('Stop', () => this.services.daemon.stop());
        return;
      case 'restart':
        this.runDaemonAction('Restart', () => this.services.daemon.restart());
        return;
      case 'update':
        this.updateFromTray();
        return;
    }
  }

  private runDaemonAction(label: string, action: () => Promise<DaemonView>): void {
    action()
      .catch((error: unknown) => {
        notify(`agentpager: ${label} không thành công`, toApiError(error).message);
        this.log.error(`tray ${label} failed`, error);
      })
      .finally(() => {
        this.refreshStatus();
      });
  }

  private refreshStatus(): void {
    this.poller.refresh().catch((error: unknown) => {
      this.log.error('status refresh failed', error);
    });
  }

  private watchConfigFile(): void {
    mkdirSync(this.paths.root, { recursive: true });
    this.configWatcher = watchConfig({
      dir: this.paths.root,
      fileName: basename(this.paths.config),
      watch: (dir, listener) => {
        const watcher = watchFolder(dir, (_event, fileName) => {
          listener(fileName);
        });
        watcher.on('error', (error) => {
          this.log.error('config watch failed', error);
        });
        return watcher;
      },
      onChange: () => {
        this.window?.webContents.send(EVENTS.configChanged, null);
      },
    });
  }

  private async pick(options: OpenDialogOptions): Promise<string | null> {
    const result = this.window ? await dialog.showOpenDialog(this.window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }

  private async openPath(path: string): Promise<void> {
    const problem = await shell.openPath(path);
    if (problem !== '') throw new Error(`Không mở được ${path}: ${problem}`);
  }
}

function installCrashHandlers(log: DesktopLog): void {
  const report = (context: string, error: unknown): void => {
    try {
      log.error(context, error);
    } catch (logError) {
      console.error('agentpager: desktop.log is not writable:', logError, 'while reporting:', error);
    }
    if (app.isReady()) dialog.showErrorBox('agentpager gặp lỗi', `${context}: ${messageOf(error)}\n\nChi tiết trong desktop.log.`);
  };
  process.on('uncaughtException', (error) => {
    report('uncaught exception', error);
  });
  process.on('unhandledRejection', (reason) => {
    report('unhandled rejection', reason);
  });
}

/** macOS: an app started from the disk image or Downloads is offered a move to Applications. True when moving. */
function offerMoveToApplications(paths: AppPaths, home: string | null, log: DesktopLog): boolean {
  if (process.platform !== 'darwin') return false;
  const file = join(paths.root, DESKTOP_STATE_FILE);
  const offer = shouldOfferMove({
    platform: process.platform,
    isPackaged: app.isPackaged,
    inApplicationsFolder: app.isInApplicationsFolder(),
    execPath: process.execPath,
    declinedPath: readDesktopState(file).declinedMovePath ?? null,
    homeOverride: home,
  });
  if (!offer) return false;
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Chuyển', 'Để sau'],
    defaultId: 0,
    cancelId: 1,
    message: 'Chuyển agentpager vào thư mục Applications?',
    detail: 'Tự khởi động bot cần app nằm trong Applications. Chạy thẳng từ file .dmg hoặc thư mục Downloads sẽ hỏng sau khi khởi động lại máy.',
  });
  if (choice === 1) {
    updateDesktopState(file, { declinedMovePath: process.execPath });
    return false;
  }
  try {
    return app.moveToApplicationsFolder();
  } catch (error) {
    log.error('moving to Applications failed', error);
    dialog.showErrorBox('Không chuyển được agentpager vào Applications', messageOf(error));
    return false;
  }
}

/** The GUI: tray, window and IPC handlers. The bot itself always runs in a separate daemon process. */
export function startAppShell(options: AppShellOptions): void {
  if (!app.requestSingleInstanceLock()) {
    // Another GUI is running; it focuses its window on 'second-instance'.
    app.quit();
    return;
  }
  const platform = currentPlatform();
  const paths = appPaths(platform);
  const log = createDesktopLog(paths.logs);
  installCrashHandlers(log);
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
  const processInfo: AppProcessInfo = { execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath() };
  const services = createServices(paths, platform, processInfo, log);

  app
    .whenReady()
    .then(() => {
      // Moving relaunches the app from Applications; this instance quits.
      if (offerMoveToApplications(paths, services.homeOverride, log)) return;
      // macOS login items cannot pass --hidden; they report being opened at login instead.
      const hidden = options.hidden || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
      new AppShell(paths, services, log).start(hidden);
      resumeAfterUpdate({
        consume: () => consumeResumeMarker(paths.root, new Date()),
        status: () => services.daemon.status(),
        start: () => services.daemon.start(),
        notify,
        log,
        version: app.getVersion(),
      }).catch((error: unknown) => {
        log.error('resuming the bot after an update failed', error);
      });
    })
    .catch((error: unknown) => {
      log.error('app failed to start', error);
      dialog.showErrorBox('agentpager không khởi động được', messageOf(error));
      app.exit(1);
    });
}
