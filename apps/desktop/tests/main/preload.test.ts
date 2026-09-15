import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentpagerApi, LogLine } from '../../src/shared/api.js';
import { EVENTS, INVOKE } from '../../src/shared/channels.js';

type Handler = (event: unknown, payload: unknown) => void;

const electron = vi.hoisted(() => {
  const invocations: unknown[][] = [];
  const handlers = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  const exposed: Record<string, unknown> = {};
  return {
    invocations,
    handlers,
    exposed,
    emit: (channel: string, payload: unknown) => {
      for (const handler of handlers.get(channel) ?? []) handler({}, payload);
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      electron.exposed[key] = value;
    },
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => {
      electron.invocations.push(args);
      return Promise.resolve({ ok: true, data: null });
    },
    on: (channel: string, handler: Handler) => {
      const set = electron.handlers.get(channel) ?? new Set<Handler>();
      set.add(handler);
      electron.handlers.set(channel, set);
    },
    removeListener: (channel: string, handler: Handler) => {
      electron.handlers.get(channel)?.delete(handler);
    },
  },
}));

let api: AgentpagerApi;

beforeAll(async () => {
  await import('../../src/preload/index.js');
  api = electron.exposed.agentpager as AgentpagerApi;
});

describe('preload bridge', () => {
  it('sends every request on its channel with its arguments', async () => {
    electron.invocations.length = 0;
    const patch = { logLevel: 'debug' as const };
    const input = { botToken: 't', usernames: ['alice_one'], projectsRoot: 'D:\\', agent: { provider: 'fake', executable: null }, idleTimeoutMinutes: 60 };
    await Promise.all([
      api.config.load(),
      api.config.save(patch),
      api.config.runWizard(input, true),
      api.config.verifyToken('t'),
      api.config.defaults(),
      api.users.add('alice_one'),
      api.users.remove('alice_one'),
      api.users.unpair('alice_one'),
      api.daemon.status(),
      api.daemon.start(),
      api.daemon.stop(),
      api.daemon.restart(),
      api.daemon.switchToApp(),
      api.autostart.get(),
      api.autostart.set(true),
      api.loginItem.get(),
      api.loginItem.set(false),
      api.agent.providers(),
      api.agent.detect('fake', null),
      api.dialog.pickFolder('D:\\'),
      api.dialog.pickExecutable(null),
      api.shell.openLogFolder(),
      api.shell.openConfigFile(),
      api.app.info(),
      api.app.uninstall(),
      api.update.get(),
      api.update.check(),
      api.update.install('ask'),
      api.update.cancelWaiting(),
      api.update.openDownload(),
    ]);
    expect(electron.invocations).toEqual([
      [INVOKE.configLoad],
      [INVOKE.configSave, patch],
      [INVOKE.configRunWizard, input, true],
      [INVOKE.configVerifyToken, 't'],
      [INVOKE.configDefaults],
      [INVOKE.usersAdd, 'alice_one'],
      [INVOKE.usersRemove, 'alice_one'],
      [INVOKE.usersUnpair, 'alice_one'],
      [INVOKE.daemonStatus],
      [INVOKE.daemonStart],
      [INVOKE.daemonStop],
      [INVOKE.daemonRestart],
      [INVOKE.daemonSwitchToApp],
      [INVOKE.autostartGet],
      [INVOKE.autostartSet, true],
      [INVOKE.loginItemGet],
      [INVOKE.loginItemSet, false],
      [INVOKE.agentProviders],
      [INVOKE.agentDetect, 'fake', null],
      [INVOKE.dialogPickFolder, 'D:\\'],
      [INVOKE.dialogPickExecutable, null],
      [INVOKE.shellOpenLogFolder],
      [INVOKE.shellOpenConfigFile],
      [INVOKE.appInfo],
      [INVOKE.appUninstall],
      [INVOKE.updateGet],
      [INVOKE.updateCheck],
      [INVOKE.updateInstall, 'ask'],
      [INVOKE.updateCancelWaiting],
      [INVOKE.updateOpenDownload],
    ]);
  });

  it('delivers pushed update views until unsubscribed', () => {
    const views: unknown[] = [];
    const stop = api.onUpdate((view) => views.push(view));
    electron.emit(EVENTS.update, { kind: 'checking' });
    stop();
    electron.emit(EVENTS.update, { kind: 'idle' });
    expect(views).toEqual([{ kind: 'checking' }]);
  });

  it('delivers pushed status and config changes until unsubscribed', () => {
    const statuses: unknown[] = [];
    let configChanges = 0;
    const stopStatus = api.onStatus((view) => statuses.push(view));
    const stopConfig = api.onConfigChanged(() => {
      configChanges += 1;
    });
    electron.emit(EVENTS.status, { badge: 'running' });
    electron.emit(EVENTS.configChanged, null);
    stopStatus();
    stopConfig();
    electron.emit(EVENTS.status, { badge: 'stopped' });
    electron.emit(EVENTS.configChanged, null);
    expect(statuses).toEqual([{ badge: 'running' }]);
    expect(configChanges).toBe(1);
  });

  it('routes log lines to their own subscription and stops it on unsubscribe', () => {
    electron.invocations.length = 0;
    const first: LogLine[][] = [];
    const second: LogLine[][] = [];
    const stopFirst = api.logs.subscribe('worker', (lines) => first.push(lines));
    const stopSecond = api.logs.subscribe('supervisor', (lines) => second.push(lines));
    const [firstId, secondId] = electron.invocations.map((call) => call[1]);
    expect(electron.invocations).toEqual([
      [INVOKE.logsSubscribe, firstId, 'worker'],
      [INVOKE.logsSubscribe, secondId, 'supervisor'],
    ]);
    expect(firstId).not.toBe(secondId);

    const line: LogLine = { time: 1, level: 'info', message: 'hello', extra: null };
    electron.emit(EVENTS.logLines, { id: firstId, lines: [line] });
    stopFirst();
    electron.emit(EVENTS.logLines, { id: firstId, lines: [line] });
    expect(first).toEqual([[line]]);
    expect(second).toEqual([]);
    expect(electron.invocations.at(-1)).toEqual([INVOKE.logsUnsubscribe, firstId]);
    stopSecond();
  });
});
