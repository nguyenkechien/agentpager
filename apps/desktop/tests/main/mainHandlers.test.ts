import { describe, expect, it } from 'vitest';
import type { CallerContext } from '../../src/main/ipc/handlers.js';
import { createMainHandlers, type MainHandlerDeps } from '../../src/main/mainHandlers.js';
import type { DaemonView, LogLine, LogSource } from '../../src/shared/api.js';
import { EVENTS, INVOKE } from '../../src/shared/channels.js';

const stopped: DaemonView = {
  badge: 'stopped',
  pid: null,
  startedAt: null,
  workerPid: null,
  restarts: 0,
  botUsername: null,
  provider: null,
  lastError: null,
  launcher: null,
};

function harness() {
  const calls: unknown[][] = [];
  const pushed: { channel: string; payload: unknown }[] = [];
  const subscriptions: { senderId: number; id: string; source: LogSource; send: (lines: LogLine[]) => void }[] = [];
  let refreshes = 0;
  const record =
    (name: string, result: unknown = name) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve(result);
    };
  const deps = {
    config: {
      load: record('config.load'),
      save: record('config.save'),
      runWizard: record('config.runWizard'),
      verifyToken: record('config.verifyToken'),
      defaults: record('config.defaults'),
      addUser: record('config.addUser'),
      removeUser: record('config.removeUser'),
      unpairUser: record('config.unpairUser'),
    },
    daemon: {
      status: record('daemon.status', stopped),
      start: () => Promise.reject(new Error('fatal start')),
      stop: record('daemon.stop', stopped),
      restart: record('daemon.restart', stopped),
    },
    autostart: { get: record('autostart.get'), set: record('autostart.set') },
    agent: {
      providers: () => {
        calls.push(['agent.providers']);
        return [];
      },
      detect: record('agent.detect'),
    },
    loginItem: {
      get: () => true,
      set: (enabled: boolean) => enabled,
    },
    dialogs: { pickFolder: record('dialogs.pickFolder', 'D:\\Projects'), pickExecutable: record('dialogs.pickExecutable', null) },
    shell: { openLogFolder: record('shell.openLogFolder', undefined), openConfigFile: record('shell.openConfigFile', undefined) },
    logs: {
      subscribe: (senderId: number, id: string, source: LogSource, send: (lines: LogLine[]) => void) => {
        subscriptions.push({ senderId, id, source, send });
      },
      unsubscribe: (senderId: number, id: string) => {
        calls.push(['logs.unsubscribe', senderId, id]);
      },
    },
    appInfo: () => ({ homeOverride: 'D:\\tmp\\ap' }),
    refreshStatus: () => {
      refreshes += 1;
    },
  } as unknown as MainHandlerDeps;
  const caller: CallerContext = {
    senderId: 3,
    send: (channel, payload) => {
      pushed.push({ channel, payload });
    },
  };
  return { handlers: createMainHandlers(deps), calls, pushed, subscriptions, caller, refreshes: () => refreshes };
}

describe('createMainHandlers', () => {
  it('routes config, users, autostart, agent and dialog requests to their services', async () => {
    const h = harness();
    const input = { botToken: 't', usernames: ['alice_one'], projectsRoot: 'D:\\', agent: { provider: 'fake', executable: null }, idleTimeoutMinutes: 60 };
    await h.handlers[INVOKE.configLoad](h.caller);
    await h.handlers[INVOKE.configSave](h.caller, { logLevel: 'debug' });
    await h.handlers[INVOKE.configRunWizard](h.caller, input, true);
    await h.handlers[INVOKE.configVerifyToken](h.caller, 't');
    await h.handlers[INVOKE.configDefaults](h.caller);
    await h.handlers[INVOKE.usersAdd](h.caller, 'alice_one');
    await h.handlers[INVOKE.usersRemove](h.caller, 'bob_two');
    await h.handlers[INVOKE.usersUnpair](h.caller, 'carol_three');
    await h.handlers[INVOKE.autostartGet](h.caller);
    await h.handlers[INVOKE.autostartSet](h.caller, false);
    await h.handlers[INVOKE.agentProviders](h.caller);
    await h.handlers[INVOKE.agentDetect](h.caller, 'fake', null);
    await expect(h.handlers[INVOKE.dialogPickFolder](h.caller, null)).resolves.toBe('D:\\Projects');
    await h.handlers[INVOKE.dialogPickExecutable](h.caller, 'C:\\tools');
    expect(h.calls).toEqual([
      ['config.load'],
      ['config.save', { logLevel: 'debug' }],
      ['config.runWizard', input, true],
      ['config.verifyToken', 't'],
      ['config.defaults'],
      ['config.addUser', 'alice_one'],
      ['config.removeUser', 'bob_two'],
      ['config.unpairUser', 'carol_three'],
      ['autostart.get'],
      ['autostart.set', false],
      ['agent.providers'],
      ['agent.detect', 'fake', null],
      ['dialogs.pickFolder', null],
      ['dialogs.pickExecutable', 'C:\\tools'],
    ]);
    expect(h.handlers[INVOKE.loginItemGet](h.caller)).toBe(true);
    expect(h.handlers[INVOKE.loginItemSet](h.caller, false)).toBe(false);
    expect(h.handlers[INVOKE.appInfo](h.caller)).toEqual({ homeOverride: 'D:\\tmp\\ap' });
  });

  it('refreshes the status after every daemon action, even a failed one', async () => {
    const h = harness();
    await expect(h.handlers[INVOKE.daemonStatus](h.caller)).resolves.toEqual(stopped);
    expect(h.refreshes()).toBe(0);
    await expect(h.handlers[INVOKE.daemonStop](h.caller)).resolves.toEqual(stopped);
    await h.handlers[INVOKE.daemonRestart](h.caller);
    await expect(h.handlers[INVOKE.daemonStart](h.caller)).rejects.toThrow('fatal start');
    expect(h.refreshes()).toBe(3);
  });

  it('opens folders and returns null', async () => {
    const h = harness();
    await expect(h.handlers[INVOKE.shellOpenLogFolder](h.caller)).resolves.toBeNull();
    await expect(h.handlers[INVOKE.shellOpenConfigFile](h.caller)).resolves.toBeNull();
    expect(h.calls).toEqual([['shell.openLogFolder'], ['shell.openConfigFile']]);
  });

  it('subscribes log views per window and pushes their lines tagged with the subscription id', () => {
    const h = harness();
    expect(h.handlers[INVOKE.logsSubscribe](h.caller, 'logs-1', 'supervisor')).toBeNull();
    const subscription = h.subscriptions[0];
    expect(subscription).toMatchObject({ senderId: 3, id: 'logs-1', source: 'supervisor' });
    const lines: LogLine[] = [{ time: 1, level: 'info', message: 'hello', extra: null }];
    subscription?.send(lines);
    expect(h.pushed).toEqual([{ channel: EVENTS.logLines, payload: { id: 'logs-1', lines } }]);
    expect(h.handlers[INVOKE.logsUnsubscribe](h.caller, 'logs-1')).toBeNull();
    expect(h.calls).toEqual([['logs.unsubscribe', 3, 'logs-1']]);
  });
});
