import { join } from 'node:path';
import { app } from 'electron';
import { runAppDaemon } from './daemonProcess.js';
import { parseLaunchMode } from './launchMode.js';
import { startAppShell } from './shell/appShell.js';

app.setName('agentpager');
// Chromium's profile would otherwise land in %APPDATA%\agentpager, the bot's own app-data folder.
app.setPath('userData', join(app.getPath('appData'), 'agentpager-desktop'));

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
  startAppShell({ hidden: mode.hidden });
}
