import type { AppInfo, DaemonView } from '../shared/api.js';
import { EVENTS, INVOKE } from '../shared/channels.js';
import type { MainHandlers } from './ipc/handlers.js';
import type { LogSubscriptions } from './live/logStream.js';
import type { AgentService } from './services/agentService.js';
import type { AutostartService } from './services/autostartService.js';
import type { ConfigService } from './services/configService.js';
import type { DaemonService } from './services/daemonService.js';
import type { UpdateService } from './update/updateService.js';

export interface MainHandlerDeps {
  config: Pick<ConfigService, 'load' | 'save' | 'runWizard' | 'verifyToken' | 'defaults' | 'addUser' | 'removeUser' | 'unpairUser'>;
  daemon: Pick<DaemonService, 'status' | 'start' | 'stop' | 'restart' | 'switchToApp'>;
  autostart: Pick<AutostartService, 'get' | 'set'>;
  agent: Pick<AgentService, 'providers' | 'detect'>;
  loginItem: { get: () => boolean; set: (enabled: boolean) => boolean };
  dialogs: {
    pickFolder: (defaultPath: string | null) => Promise<string | null>;
    pickExecutable: (defaultPath: string | null) => Promise<string | null>;
  };
  shell: { openLogFolder: () => Promise<void>; openConfigFile: () => Promise<void> };
  logs: Pick<LogSubscriptions, 'subscribe' | 'unsubscribe'>;
  update: Pick<UpdateService, 'view' | 'check' | 'install' | 'cancelWaiting' | 'openDownload'>;
  appInfo: () => AppInfo;
  appUninstall: () => Promise<void>;
  /** After any Start/Stop/Restart, successful or not, the window and tray should see the new state at once. */
  refreshStatus: () => void;
}

export function createMainHandlers(deps: MainHandlerDeps): MainHandlers {
  const daemonAction = async (action: () => Promise<DaemonView>): Promise<DaemonView> => {
    try {
      return await action();
    } finally {
      deps.refreshStatus();
    }
  };
  return {
    [INVOKE.configLoad]: () => deps.config.load(),
    [INVOKE.configSave]: (_caller, patch) => deps.config.save(patch),
    [INVOKE.configRunWizard]: (_caller, input, overwrite) => deps.config.runWizard(input, overwrite),
    [INVOKE.configVerifyToken]: (_caller, token) => deps.config.verifyToken(token),
    [INVOKE.configDefaults]: () => deps.config.defaults(),
    [INVOKE.usersAdd]: (_caller, username) => deps.config.addUser(username),
    [INVOKE.usersRemove]: (_caller, username) => deps.config.removeUser(username),
    [INVOKE.usersUnpair]: (_caller, username) => deps.config.unpairUser(username),
    [INVOKE.daemonStatus]: () => deps.daemon.status(),
    [INVOKE.daemonStart]: () => daemonAction(() => deps.daemon.start()),
    [INVOKE.daemonStop]: () => daemonAction(() => deps.daemon.stop()),
    [INVOKE.daemonRestart]: () => daemonAction(() => deps.daemon.restart()),
    [INVOKE.daemonSwitchToApp]: () => daemonAction(() => deps.daemon.switchToApp()),
    [INVOKE.autostartGet]: () => deps.autostart.get(),
    [INVOKE.autostartSet]: (_caller, enabled) => deps.autostart.set(enabled),
    [INVOKE.loginItemGet]: () => deps.loginItem.get(),
    [INVOKE.loginItemSet]: (_caller, enabled) => deps.loginItem.set(enabled),
    [INVOKE.agentProviders]: () => deps.agent.providers(),
    [INVOKE.agentDetect]: (_caller, provider, executable) => deps.agent.detect(provider, executable),
    [INVOKE.dialogPickFolder]: (_caller, defaultPath) => deps.dialogs.pickFolder(defaultPath),
    [INVOKE.dialogPickExecutable]: (_caller, defaultPath) => deps.dialogs.pickExecutable(defaultPath),
    [INVOKE.shellOpenLogFolder]: async () => {
      await deps.shell.openLogFolder();
      return null;
    },
    [INVOKE.shellOpenConfigFile]: async () => {
      await deps.shell.openConfigFile();
      return null;
    },
    [INVOKE.appInfo]: () => deps.appInfo(),
    [INVOKE.appUninstall]: async () => {
      await deps.appUninstall();
      return null;
    },
    [INVOKE.updateGet]: () => deps.update.view(),
    [INVOKE.updateCheck]: () => deps.update.check(),
    [INVOKE.updateInstall]: (_caller, mode) => deps.update.install(mode),
    [INVOKE.updateCancelWaiting]: () => deps.update.cancelWaiting(),
    [INVOKE.updateOpenDownload]: () => deps.update.openDownload(),
    [INVOKE.logsSubscribe]: (caller, id, source) => {
      deps.logs.subscribe(caller.senderId, id, source, (lines) => {
        caller.send(EVENTS.logLines, { id, lines });
      });
      return null;
    },
    [INVOKE.logsUnsubscribe]: (caller, id) => {
      deps.logs.unsubscribe(caller.senderId, id);
      return null;
    },
  };
}
