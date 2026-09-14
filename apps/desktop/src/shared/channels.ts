/** IPC channel names shared by the main process and the preload bridge. */

export const INVOKE = {
  configLoad: 'config:load',
  configSave: 'config:save',
  configRunWizard: 'config:run-wizard',
  configVerifyToken: 'config:verify-token',
  configDefaults: 'config:defaults',
  usersAdd: 'users:add',
  usersRemove: 'users:remove',
  usersUnpair: 'users:unpair',
  daemonStatus: 'daemon:status',
  daemonStart: 'daemon:start',
  daemonStop: 'daemon:stop',
  daemonRestart: 'daemon:restart',
  autostartGet: 'autostart:get',
  autostartSet: 'autostart:set',
  loginItemGet: 'login-item:get',
  loginItemSet: 'login-item:set',
  agentProviders: 'agent:providers',
  agentDetect: 'agent:detect',
  dialogPickFolder: 'dialog:pick-folder',
  dialogPickExecutable: 'dialog:pick-executable',
  shellOpenLogFolder: 'shell:open-log-folder',
  shellOpenConfigFile: 'shell:open-config-file',
  appInfo: 'app:info',
  logsSubscribe: 'logs:subscribe',
  logsUnsubscribe: 'logs:unsubscribe',
} as const;

export type InvokeChannel = (typeof INVOKE)[keyof typeof INVOKE];

/** Main → renderer pushes. */
export const EVENTS = {
  status: 'event:status',
  configChanged: 'event:config-changed',
  logLines: 'event:log-lines',
} as const;
