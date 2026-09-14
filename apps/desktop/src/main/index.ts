import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { runAppDaemon } from './daemonProcess.js';
import { parseLaunchMode } from './launchMode.js';

const mode = parseLaunchMode(process.argv);

if (mode.kind === 'daemon') {
  if (process.platform === 'darwin') app.dock?.hide();
  runAppDaemon({ execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath() }).then(
    (code) => {
      app.exit(code);
    },
    (error: unknown) => {
      console.error('agentpager daemon failed:', error);
      app.exit(1);
    },
  );
} else {
  void app.whenReady().then(() => {
    const window = new BrowserWindow({
      width: 960,
      height: 680,
      show: !mode.hidden,
      webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true },
    });
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) void window.loadURL(rendererUrl);
    else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  });
}
