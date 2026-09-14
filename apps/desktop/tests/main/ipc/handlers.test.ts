import { describe, expect, it } from 'vitest';
import { registerHandlers, UNTRUSTED_SENDER_MESSAGE, type CallerContext, type InvokeEventLike, type MainHandlers } from '../../../src/main/ipc/handlers.js';
import { INVOKE_ARGS } from '../../../src/main/ipc/schemas.js';
import { ApiFailure } from '../../../src/main/services/results.js';
import { INVOKE, type InvokeChannel } from '../../../src/shared/channels.js';

const APP_URL = 'file:///C:/agentpager/resources/app.asar/out/renderer/index.html';

type Listener = (event: InvokeEventLike, ...args: unknown[]) => Promise<unknown>;

interface Harness {
  calls: { channel: InvokeChannel; caller: CallerContext; args: unknown[] }[];
  pushed: { channel: string; args: unknown[] }[];
  listeners: Map<string, Listener>;
  handlers: MainHandlers;
  call: (channel: string, url: string | null, ...args: unknown[]) => Promise<unknown>;
}

function harness(): Harness {
  const calls: Harness['calls'] = [];
  const pushed: Harness['pushed'] = [];
  const listeners = new Map<string, Listener>();
  const handlers = Object.fromEntries(
    Object.values(INVOKE).map((channel) => [
      channel,
      (caller: CallerContext, ...args: unknown[]) => {
        calls.push({ channel, caller, args });
        return { channel, args };
      },
    ]),
  ) as MainHandlers;
  registerHandlers(
    {
      handle: (channel, listener) => {
        if (listeners.has(channel)) throw new Error(`registered twice: ${channel}`);
        listeners.set(channel, listener);
      },
    },
    handlers,
    (url) => url === APP_URL,
  );
  const call = (channel: string, url: string | null, ...args: unknown[]): Promise<unknown> => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`no handler for ${channel}`);
    const event: InvokeEventLike = {
      senderFrame: url === null ? null : { url },
      sender: {
        id: 7,
        send: (pushChannel, ...pushArgs) => {
          pushed.push({ channel: pushChannel, args: pushArgs });
        },
      },
    };
    return listener(event, ...args);
  };
  return { calls, pushed, listeners, handlers, call };
}

describe('registerHandlers', () => {
  it('validates arguments for every channel and registers each channel once', () => {
    expect(Object.keys(INVOKE_ARGS).sort()).toEqual(Object.values(INVOKE).sort());
    expect([...harness().listeners.keys()].sort()).toEqual(Object.values(INVOKE).sort());
  });

  it('refuses callers that are not the app window', async () => {
    const h = harness();
    const refused = { ok: false, error: { code: 'unauthorized', message: UNTRUSTED_SENDER_MESSAGE } };
    await expect(h.call(INVOKE.daemonStop, 'https://example.com/')).resolves.toEqual(refused);
    await expect(h.call(INVOKE.daemonStop, null)).resolves.toEqual(refused);
    expect(h.calls).toEqual([]);
  });

  it('rejects malformed arguments before calling the service', async () => {
    const h = harness();
    for (const [channel, args] of [
      [INVOKE.autostartSet, ['yes']],
      [INVOKE.configSave, [{ color: 'blue' }]],
      [INVOKE.configSave, [{ agent: { provider: 'fake', extra: true } }]],
      [INVOKE.usersAdd, []],
      [INVOKE.daemonStart, ['now']],
      [INVOKE.logsSubscribe, ['logs-1', 'everything']],
      [INVOKE.configRunWizard, [{ botToken: 't', usernames: 'alice', projectsRoot: 'D:\\', agent: { provider: 'x', executable: null }, idleTimeoutMinutes: 60 }, false]],
    ] as const) {
      const result = await h.call(channel, APP_URL, ...args);
      expect(result, channel).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    }
    expect(h.calls).toEqual([]);
  });

  it('calls the handler with the parsed arguments and a way to push back to the caller', async () => {
    const h = harness();
    const patch = { idleTimeoutMinutes: 30, agent: { defaultModel: null } };
    await expect(h.call(INVOKE.configSave, APP_URL, patch)).resolves.toEqual({ ok: true, data: { channel: INVOKE.configSave, args: [patch] } });
    await h.call(INVOKE.logsSubscribe, APP_URL, 'logs-1', 'supervisor');
    const caller = h.calls.at(-1)?.caller;
    expect(h.calls.at(-1)?.args).toEqual(['logs-1', 'supervisor']);
    expect(caller?.senderId).toBe(7);
    caller?.send('event:log-lines', { id: 'logs-1', lines: [] });
    expect(h.pushed).toEqual([{ channel: 'event:log-lines', args: [{ id: 'logs-1', lines: [] }] }]);
  });

  it('turns thrown errors into failures', async () => {
    const h = harness();
    h.handlers[INVOKE.daemonStart] = () => {
      throw new ApiFailure({ code: 'fatal', message: 'Chưa có cấu hình' });
    };
    h.handlers[INVOKE.daemonStop] = () => Promise.reject(new Error('EPERM'));
    await expect(h.call(INVOKE.daemonStart, APP_URL)).resolves.toEqual({ ok: false, error: { code: 'fatal', message: 'Chưa có cấu hình' } });
    await expect(h.call(INVOKE.daemonStop, APP_URL)).resolves.toEqual({ ok: false, error: { code: 'failed', message: 'EPERM' } });
  });
});
