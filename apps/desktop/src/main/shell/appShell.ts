import { existsSync, mkdirSync, watch as watchFolder, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ConfigStore } from '@chiennguyen/agentpager/config';
import {
  followLog,
  followLogFile,
  lastDaemonFatal,
  notifyUsersChanged,
  readLogFileTail,
  readLogTail,
  supervisorLogFile,
} from '@chiennguyen/agentpager/control';
import { ipcRequest, readDaemonInfo, type IpcCommand } from '@chiennguyen/agentpager/daemon';
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
  Notification,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
  type OpenDialogOptions,
  type RenderProcessGoneDetails,
} from 'electron';
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
import { createDesktopLog, type DesktopLog } from './desktopLog.js';
import { trayModel, type TrayAction, type TrayColor } from './trayModel.js';
import { circlePng } from './trayIcon.js';
import { isTrustedRendererUrl, type RendererLocation } from './trustedUrl.js';

export const APP_USER_MODEL_ID = 'io.github.nguyenkechien.agentpager';
const LOGIN_ITEM_ARGS = ['--hidden'];
/** App-data file remembering that the "still running in the tray" notice was shown. */
const DESKTOP_STATE_FILE = 'desktop.json';

export interface AppShellOptions {
  hidden: boolean;
}

interface Services {
  homeOverride: string | null;
  config: ConfigService;
  daemon: DaemonService;
  autostart: AutostartService;
  agent: AgentService;
  logReaders: LogReaders;
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

function createServices(paths: AppPaths, platform: PlatformInfo, processInfo: AppProcessInfo): Services {
  const catalog = providerCatalog;
  const store = new ConfigStore(paths.config, { platform: platform.platform, catalog });
  const ipc = async (command: IpcCommand): Promise<unknown> => ipcRequest(await readDaemonInfo(paths.daemonInfo), command);
  return {
    homeOverride: homeOverride(platform),
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
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
      now: () => Date.now(),
      readDaemonInfo: () => readDaemonInfo(paths.daemonInfo),
      logsDir: paths.logs,
    }),
    autostart: new AutostartService({
      autostart: createAutostart(defaultAutostartDeps(paths, platform)),
      target: appAutostartTarget(daemonCommand(processInfo), platform.homedir),
      platform: platform.platform,
      homeOverride: homeOverride(platform),
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

function trayImage(color: TrayColor): NativeImage {
  const image = nativeImage.createFromBuffer(circlePng(color, 16));
  image.addRepresentation({ scaleFactor: 2, buffer: circlePng(color, 32) });
  return image;
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

class AppShell {
  private window: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private quitting = false;
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
        appInfo: () => ({ homeOverride: this.services.homeOverride }),
        refreshStatus: () => {
          this.refreshStatus();
        },
      }),
      (url) => isTrustedRendererUrl(url, this.rendererLocation()),
    );

    this.tray = new Tray(trayImage('grey'));
    this.tray.on('click', () => {
      this.showWindow();
    });
    this.renderTray(null);
    this.poller.start();
    this.watchConfigFile();

    app.on('second-instance', () => {
      this.showWindow();
    });
    app.on('activate', () => {
      this.showWindow();
    });
    app.on('before-quit', () => {
      this.quitting = true;
      this.poller.stop();
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
    if (existsSync(file)) return;
    notify('agentpager vẫn chạy trong khay', 'Bot vẫn hoạt động. Mở lại từ icon agentpager; "Thoát app" chỉ đóng app, bot vẫn chạy.');
    try {
      mkdirSync(this.paths.root, { recursive: true });
      writeFileSync(file, `${JSON.stringify({ trayNoticeShownAt: new Date().toISOString() })}\n`, 'utf8');
    } catch (error) {
      // Worst case the notice shows again next time.
      this.log.error('could not remember the tray notice', error);
    }
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
    const model = trayModel(view);
    tray.setImage(trayImage(model.color));
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
  const services = createServices(paths, platform, processInfo);

  app
    .whenReady()
    .then(() => {
      // macOS login items cannot pass --hidden; they report being opened at login instead.
      const hidden = options.hidden || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
      new AppShell(paths, services, log).start(hidden);
    })
    .catch((error: unknown) => {
      log.error('app failed to start', error);
      dialog.showErrorBox('agentpager không khởi động được', messageOf(error));
      app.exit(1);
    });
}
