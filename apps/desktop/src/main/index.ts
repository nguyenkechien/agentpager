import { join } from 'node:path';
import { app } from 'electron';
import { runAppDaemon } from './daemonProcess.js';
import { parseLaunchMode } from './launchMode.js';
import { runMaintenance } from './maintenance/run.js';
import { startAppShell } from './shell/appShell.js';

app.setName('agentpager');
// Chromium's profile would otherwise land in %APPDATA%\agentpager, the bot's own app-data folder.
app.setPath('userData', join(app.getPath('appData'), 'agentpager-desktop'));

const mode = parseLaunchMode(process.argv);

if (mode.kind === 'daemon') {
  // The daemon never draws anything. Disabling hardware acceleration alone still starts a GPU process; keeping the GPU
  // thread in-process as well removes it (measured on Windows: 94 MB → 38 MB private memory for the daemon's processes).
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
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
} else if (mode.kind === 'maintenance') {
  // Run by the installer: no window, no tray, no GPU process.
  app.disableHardwareAcceleration();
  if (process.platform === 'darwin') app.dock?.hide();
  runMaintenance(mode.task).then(
    (code) => {
      app.exit(code);
    },
    (error: unknown) => {
      console.error(`agentpager ${mode.task} failed:`, error);
      app.exit(1);
    },
  );
} else {
  startAppShell({ hidden: mode.hidden });
}
