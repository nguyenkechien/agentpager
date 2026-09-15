import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AgentDetectionView,
  AgentpagerApi,
  ApiResult,
  AppInfo,
  AutostartView,
  ConfigView,
  DaemonView,
  InstallMode,
  InstallResult,
  LogLine,
  LogSource,
  ProviderView,
  SettingsPatch,
  UpdateView,
  UsersChange,
  WizardDefaults,
  WizardInput,
} from '../shared/api.js';
import { EVENTS, INVOKE, type InvokeChannel } from '../shared/channels.js';

function invoke<T>(channel: InvokeChannel, ...args: unknown[]): Promise<ApiResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<ApiResult<T>>;
}

/** Payloads on push channels come from the main process, which sends the types named in `AgentpagerApi`. */
function listen(channel: string, listener: (payload: unknown) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: unknown): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

let nextSubscription = 0;

const api: AgentpagerApi = {
  config: {
    load: () => invoke<ConfigView>(INVOKE.configLoad),
    save: (patch: SettingsPatch) => invoke<ConfigView>(INVOKE.configSave, patch),
    runWizard: (input: WizardInput, overwrite: boolean) => invoke<ConfigView>(INVOKE.configRunWizard, input, overwrite),
    verifyToken: (token: string) => invoke<{ username: string }>(INVOKE.configVerifyToken, token),
    defaults: () => invoke<WizardDefaults>(INVOKE.configDefaults),
  },
  users: {
    add: (username: string) => invoke<UsersChange>(INVOKE.usersAdd, username),
    remove: (username: string) => invoke<UsersChange>(INVOKE.usersRemove, username),
    unpair: (username: string) => invoke<UsersChange>(INVOKE.usersUnpair, username),
  },
  daemon: {
    status: () => invoke<DaemonView>(INVOKE.daemonStatus),
    start: () => invoke<DaemonView>(INVOKE.daemonStart),
    stop: () => invoke<DaemonView>(INVOKE.daemonStop),
    restart: () => invoke<DaemonView>(INVOKE.daemonRestart),
    switchToApp: () => invoke<DaemonView>(INVOKE.daemonSwitchToApp),
  },
  autostart: {
    get: () => invoke<AutostartView>(INVOKE.autostartGet),
    set: (enabled: boolean) => invoke<AutostartView>(INVOKE.autostartSet, enabled),
  },
  loginItem: {
    get: () => invoke<boolean>(INVOKE.loginItemGet),
    set: (enabled: boolean) => invoke<boolean>(INVOKE.loginItemSet, enabled),
  },
  agent: {
    providers: () => invoke<ProviderView[]>(INVOKE.agentProviders),
    detect: (provider: string, executable: string | null) => invoke<AgentDetectionView>(INVOKE.agentDetect, provider, executable),
  },
  dialog: {
    pickFolder: (defaultPath: string | null) => invoke<string | null>(INVOKE.dialogPickFolder, defaultPath),
    pickExecutable: (defaultPath: string | null) => invoke<string | null>(INVOKE.dialogPickExecutable, defaultPath),
  },
  shell: {
    openLogFolder: () => invoke<null>(INVOKE.shellOpenLogFolder),
    openConfigFile: () => invoke<null>(INVOKE.shellOpenConfigFile),
  },
  app: {
    info: () => invoke<AppInfo>(INVOKE.appInfo),
    uninstall: () => invoke<null>(INVOKE.appUninstall),
  },
  update: {
    get: () => invoke<UpdateView>(INVOKE.updateGet),
    check: () => invoke<UpdateView>(INVOKE.updateCheck),
    install: (mode: InstallMode) => invoke<InstallResult>(INVOKE.updateInstall, mode),
    cancelWaiting: () => invoke<UpdateView>(INVOKE.updateCancelWaiting),
    openDownload: () => invoke<InstallResult>(INVOKE.updateOpenDownload),
  },
  onUpdate: (listener) =>
    listen(EVENTS.update, (payload) => {
      listener(payload as UpdateView);
    }),
  onStatus: (listener) =>
    listen(EVENTS.status, (payload) => {
      listener(payload as DaemonView);
    }),
  onConfigChanged: (listener) =>
    listen(EVENTS.configChanged, () => {
      listener();
    }),
  logs: {
    subscribe: (source: LogSource, onLines: (lines: LogLine[]) => void) => {
      nextSubscription += 1;
      const id = `logs-${String(nextSubscription)}`;
      const stopListening = listen(EVENTS.logLines, (payload) => {
        const batch = payload as { id: string; lines: LogLine[] };
        if (batch.id === id) onLines(batch.lines);
      });
      void invoke<null>(INVOKE.logsSubscribe, id, source);
      return () => {
        stopListening();
        void invoke<null>(INVOKE.logsUnsubscribe, id);
      };
    },
  },
};

contextBridge.exposeInMainWorld('agentpager', api);
