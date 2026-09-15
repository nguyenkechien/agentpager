import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import type { CliDeps } from '../../src/cli/types.js';
import { MISSING_CONFIG_MESSAGE } from '../../src/core/config/store.js';
import { createTestCli, FakeIo, runningStatus, TOKEN, validConfig, type TestState } from './support.js';

async function configured() {
  const cli = createTestCli();
  await cli.store.write(validConfig());
  return cli;
}

/** A daemon whose worker reports `starting` for a couple of status polls before it is `running`. */
function slowStartingDaemon(deps: CliDeps, state: TestState): { deps: CliDeps; statusPolls: () => number } {
  let polls = 0;
  state.onSpawn = () => {
    state.daemon = runningStatus({ workerState: 'starting' });
  };
  const ipc = deps.ipc;
  return {
    deps: {
      ...deps,
      ipc: async (command) => {
        const result = await ipc(command);
        if (command === 'status' && state.daemon?.workerState === 'starting') {
          polls += 1;
          if (polls >= 2) state.daemon = runningStatus();
        }
        return result;
      },
    },
    statusPolls: () => polls,
  };
}

describe('start', () => {
  it('reports a daemon that is already running', async () => {
    const { deps, state } = await configured();
    state.daemon = runningStatus();
    const io = new FakeIo();
    await expect(runCli(['start'], io, deps)).resolves.toBe(0);
    expect(io.outs).toEqual(['agentpager is already running (pid 4242)']);
    expect(state.spawned).toBe(0);
  });

  it('spawns the daemon and waits until the worker is ready', async () => {
    const cli = await configured();
    const { deps, statusPolls } = slowStartingDaemon(cli.deps, cli.state);
    const io = new FakeIo();
    await expect(runCli(['start'], io, deps)).resolves.toBe(0);
    expect(cli.state.spawned).toBe(1);
    expect(statusPolls()).toBe(2);
    expect(io.outs).toEqual(['✅ agentpager is running · bot @test_bot · pid 4242']);
  });

  it('prints the fatal worker error when startup fails', async () => {
    const { deps, state } = await configured();
    state.onSpawn = () => {
      state.fatal = 'Invalid Telegram token (401 Unauthorized)';
    };
    const io = new FakeIo();
    await expect(runCli(['start'], io, deps)).resolves.toBe(1);
    expect(io.errs).toEqual(['❌ Invalid Telegram token (401 Unauthorized)']);
  });

  it('gives up after 20 seconds and points at the logs', async () => {
    const { deps, state } = await configured();
    const io = new FakeIo();
    const startedAt = state.clock;
    await expect(runCli(['start'], io, deps)).resolves.toBe(1);
    expect(state.clock - startedAt).toBeGreaterThanOrEqual(20_000);
    expect(io.errs).toEqual([`❌ agentpager was not ready after 20 seconds — see the logs in ${deps.paths.logs}`]);
  });

  it('refuses to start without a config', async () => {
    const { deps, state } = createTestCli();
    const io = new FakeIo();
    await expect(runCli(['start'], io, deps)).resolves.toBe(1);
    expect(io.errs).toEqual([MISSING_CONFIG_MESSAGE]);
    expect(state.spawned).toBe(0);
  });

  it('runs the supervisor in the terminal with --foreground', async () => {
    const { deps, state } = await configured();
    const io = new FakeIo();
    await expect(runCli(['start', '--foreground'], io, deps)).resolves.toBe(0);
    expect(state.foregroundRuns).toEqual([true]);

    state.daemon = runningStatus();
    await expect(runCli(['start', '--foreground'], new FakeIo(), deps)).resolves.toBe(1);
    expect(state.foregroundRuns).toEqual([true]);
  });
});

describe('stop and restart', () => {
  it('stops a running daemon and explains when none runs', async () => {
    const { deps, state } = await configured();
    const idle = new FakeIo();
    await expect(runCli(['stop'], idle, deps)).resolves.toBe(0);
    expect(idle.outs).toEqual(['agentpager is not running']);

    state.daemon = runningStatus();
    const io = new FakeIo();
    await expect(runCli(['stop'], io, deps)).resolves.toBe(0);
    expect(io.outs).toEqual(['⏹ Stopped agentpager.']);
    expect(state.ipcCalls).toContain('stop');
  });

  it('restarts the worker of a running daemon', async () => {
    const { deps, state } = await configured();
    state.daemon = runningStatus();
    const io = new FakeIo();
    await expect(runCli(['restart'], io, deps)).resolves.toBe(0);
    expect(io.outs).toEqual(['🔄 Restarting…', '✅ agentpager is running · bot @test_bot · pid 4242']);
    expect(state.daemon.workerPid).toBe(5001);
  });

  it('starts the daemon when restart finds nothing running', async () => {
    const { deps, state } = await configured();
    state.onSpawn = () => {
      state.daemon = runningStatus();
    };
    await expect(runCli(['restart'], new FakeIo(), deps)).resolves.toBe(0);
    expect(state.spawned).toBe(1);
  });
});

describe('status', () => {
  it('shows daemon, agent, users, token and autostart', async () => {
    const { deps, state } = await configured();
    state.daemon = runningStatus({ restarts: 2, lastError: 'Worker exited unexpectedly (code 1)' });
    state.autostartStatus = { enabled: true, target: null, problems: ['No longer exists: C:\\old\\node.exe'] };
    const io = new FakeIo();
    await expect(runCli(['status'], io, deps)).resolves.toBe(0);
    expect(io.outs).toEqual([
      'agentpager 0.1.0',
      'Daemon: running · pid 4242 · worker running · bot @test_bot · restarted 2 times',
      '  Last error: Worker exited unexpectedly (code 1)',
      '  Work: idle',
      'Agent: Fake Agent · C:\\tools\\claude.exe (2.1.0 (Claude Code))',
      'Projects: D:\\Projects',
      'Bot token: 123456…vwx',
      'Users: @alice_one (paired), @bob_two (pending pairing)',
      'Autostart: on',
      '  ⚠️ No longer exists: C:\\old\\node.exe',
      '  Run "agentpager autostart on" again to fix it.',
      `Config file: ${deps.paths.config}`,
      `Log: ${deps.paths.logs}`,
    ]);
  });

  it('shows how busy the agent is, and nothing for daemons that do not report it', async () => {
    const { deps, state } = await configured();
    state.daemon = runningStatus({ activeTurns: 1, queuedInputs: 2 });
    const busy = new FakeIo();
    await runCli(['status'], busy, deps);
    expect(busy.outs[2]).toBe('  Work: running 1 turn, 2 queued messages');

    state.daemon = runningStatus({ activeTurns: null, queuedInputs: null });
    const older = new FakeIo();
    await runCli(['status'], older, deps);
    expect(older.outs.some((line) => line.includes('Work:'))).toBe(false);
  });

  it('still reports what it can without a daemon or config', async () => {
    const { deps, state } = createTestCli();
    state.autostartStatus = new Error('Autostart is only supported on Windows and macOS');
    const io = new FakeIo();
    await expect(runCli(['status'], io, deps)).resolves.toBe(1);
    expect(io.outs).toEqual([
      'agentpager 0.1.0',
      'Daemon: not running',
      `Config: ${MISSING_CONFIG_MESSAGE}`,
      'Autostart: Autostart is only supported on Windows and macOS',
      `Config file: ${deps.paths.config}`,
      `Log: ${deps.paths.logs}`,
    ]);
  });
});

describe('logs', () => {
  const time = new Date(2026, 8, 14, 9, 0, 0).getTime();
  const line = (msg: string): string => JSON.stringify({ level: 30, time, msg });

  it('prints the last lines formatted, 50 by default', async () => {
    const { deps, state } = await configured();
    state.logLines = [line('one'), line('two'), line('three')];
    const io = new FakeIo();
    await expect(runCli(['logs'], io, deps)).resolves.toBe(0);
    expect(state.tailRequests).toEqual([50]);
    expect(io.outs).toEqual(['09:00:00 INFO  one', '09:00:00 INFO  two', '09:00:00 INFO  three']);

    const two = new FakeIo();
    await expect(runCli(['logs', '-n', '2'], two, deps)).resolves.toBe(0);
    expect(two.outs).toEqual(['09:00:00 INFO  two', '09:00:00 INFO  three']);
  });

  it('validates -n and explains an empty log', async () => {
    const { deps } = await configured();
    const bad = new FakeIo();
    await expect(runCli(['logs', '-n', 'abc'], bad, deps)).resolves.toBe(1);
    expect(bad.errs).toEqual(['❌ -n needs a line count ≥ 1, e.g. agentpager logs -n 100']);

    const empty = new FakeIo();
    await expect(runCli(['logs'], empty, deps)).resolves.toBe(0);
    expect(empty.outs).toEqual([`No logs yet in ${deps.paths.logs}`]);
  });

  it('follows new lines with -f until interrupted', async () => {
    const { deps, state } = await configured();
    state.logLines = [line('old')];
    state.followedLines = [line('new')];
    const io = new FakeIo();
    await expect(runCli(['logs', '-f'], io, deps)).resolves.toBe(0);
    expect(io.outs).toEqual(['09:00:00 INFO  old', '09:00:00 INFO  new']);
    expect(state.followStopped).toBe(true);
  });
});

describe('autostart', () => {
  it('turns autostart on and off with the captured node and CLI paths', async () => {
    const { deps, state } = await configured();
    const on = new FakeIo();
    await expect(runCli(['autostart', 'on'], on, deps)).resolves.toBe(0);
    expect(on.outs).toEqual(['Enabled agentpager autostart.']);
    await expect(runCli(['autostart', 'off'], new FakeIo(), deps)).resolves.toBe(0);
    expect(state.autostartCalls).toEqual([
      'enable:C:\\Program Files\\nodejs\\node.exe|C:\\npm\\node_modules\\agentpager\\dist\\cli\\main.js daemon|C:\\Users\\alex|true',
      'disable',
    ]);
  });

  it('refuses to change autostart for an AGENTPAGER_HOME folder', async () => {
    const { deps, state } = await configured();
    deps.platform = { ...deps.platform, env: { AGENTPAGER_HOME: 'D:\\tmp\\ap' } };
    for (const action of ['on', 'off']) {
      const io = new FakeIo();
      await expect(runCli(['autostart', action], io, deps)).resolves.toBe(1);
      expect(io.errs).toEqual([
        '❌ Autostart is a machine-wide setting and does not carry AGENTPAGER_HOME (D:\\tmp\\ap) — unset AGENTPAGER_HOME to turn it on or off.',
      ]);
    }
    expect(state.autostartCalls).toEqual([]);
    await expect(runCli(['autostart', 'status'], new FakeIo(), deps)).resolves.toBe(0);
  });

  it('shows the status and usage', async () => {
    const { deps, state } = await configured();
    state.autostartStatus = {
      enabled: true,
      target: { command: 'C:\\node.exe', args: ['C:\\cli.js', 'daemon'], workingDir: 'C:\\', console: true },
      problems: ['No longer exists: C:\\cli.js'],
    };
    const io = new FakeIo();
    await expect(runCli(['autostart', 'status'], io, deps)).resolves.toBe(0);
    expect(io.outs).toEqual([
      'Autostart: on',
      'Command: "C:\\node.exe" "C:\\cli.js" "daemon"',
      '⚠️ No longer exists: C:\\cli.js',
      'Run "agentpager autostart on" again to fix it.',
    ]);

    const usage = new FakeIo();
    await expect(runCli(['autostart'], usage, deps)).resolves.toBe(1);
    expect(usage.errs).toEqual(['Usage: agentpager autostart on|off|status']);
  });
});

describe('config', () => {
  it('prints the path and the config with the token masked', async () => {
    const { deps } = await configured();
    const path = new FakeIo();
    await expect(runCli(['config', 'path'], path, deps)).resolves.toBe(0);
    expect(path.outs).toEqual([deps.paths.config]);

    const show = new FakeIo();
    await expect(runCli(['config', 'show'], show, deps)).resolves.toBe(0);
    const text = show.outs.join('\n');
    expect(text).toContain('"botToken": "123456…vwx"');
    expect(text).not.toContain(TOKEN);
  });

  it('sets validated values and hints at a restart when the daemon runs', async () => {
    const { deps, state, store } = await configured();
    const idle = new FakeIo();
    await expect(runCli(['config', 'set', 'idleTimeoutMinutes', '45'], idle, deps)).resolves.toBe(0);
    expect(idle.outs).toEqual(['✅ Set idleTimeoutMinutes = 45']);

    state.daemon = runningStatus();
    const model = new FakeIo();
    await expect(runCli(['config', 'set', 'agent.defaultModel', 'smart'], model, deps)).resolves.toBe(0);
    expect(model.outs).toEqual(['✅ Set agent.defaultModel = smart', 'Run "agentpager restart" to apply it.']);
    await expect(runCli(['config', 'set', 'agent.defaultModel', 'default'], new FakeIo(), deps)).resolves.toBe(0);
    await expect(store.read()).resolves.toMatchObject({ idleTimeoutMinutes: 45, agent: { defaultModel: null } });

    const token = new FakeIo();
    await expect(runCli(['config', 'set', 'telegram.botToken', '654321:ZYXwvuTSRqpoNMLkjiHGFedc'], token, deps)).resolves.toBe(0);
    expect(token.outs[0]).toBe('✅ Set telegram.botToken = 654321…edc');
  });

  it('rejects unknown keys and invalid values', async () => {
    const { deps, store } = await configured();
    const unknown = new FakeIo();
    await expect(runCli(['config', 'set', 'color', 'blue'], unknown, deps)).resolves.toBe(1);
    expect(unknown.errs[0]).toMatch(/^No key "color"\. Keys: telegram\.botToken, projectsRoot/);

    const level = new FakeIo();
    await expect(runCli(['config', 'set', 'logLevel', 'loud'], level, deps)).resolves.toBe(1);
    expect(level.errs).toEqual(['Invalid config:', '- logLevel: invalid: loud']);

    const model = new FakeIo();
    await expect(runCli(['config', 'set', 'agent.defaultModel', 'opus'], model, deps)).resolves.toBe(1);
    expect(model.errs).toEqual(['Invalid config:', '- agent.defaultModel: "opus" is not available in Fake Agent (available: fast, smart)']);
    await expect(store.read()).resolves.toEqual(validConfig());

    const usage = new FakeIo();
    await expect(runCli(['config', 'set', 'logLevel'], usage, deps)).resolves.toBe(1);
    expect(usage.errs).toEqual(['Usage: agentpager config path | show | set <key> <value>']);
  });
});

describe('users', () => {
  const RELOADED = 'Updated the user list of the running bot.';

  it('lists paired and pending users', async () => {
    const { deps } = await configured();
    const io = new FakeIo();
    await expect(runCli(['users', 'list'], io, deps)).resolves.toBe(0);
    expect(io.outs).toEqual(['@alice_one · paired (id 111, 2026-09-14T08:00:00.000Z)', '@bob_two · pending pairing']);
  });

  it('adds, unpairs and removes users and tells a running bot', async () => {
    const { deps, state, store } = await configured();
    state.daemon = runningStatus();

    const add = new FakeIo();
    await expect(runCli(['users', 'add', '@Carol_Three'], add, deps)).resolves.toBe(0);
    expect(add.outs).toEqual(['✅ Added @carol_three — send the bot a message from this account to pair it.', RELOADED]);

    const unpair = new FakeIo();
    await expect(runCli(['users', 'unpair', 'alice_one'], unpair, deps)).resolves.toBe(0);
    expect(unpair.outs).toEqual(['✅ Unpaired @alice_one — the next message from @alice_one pairs it again.', RELOADED]);

    // With the daemon stopped the reload is attempted but there is nothing to tell.
    state.daemon = null;
    const remove = new FakeIo();
    await expect(runCli(['users', 'remove', '@bob_two'], remove, deps)).resolves.toBe(0);
    expect(remove.outs).toEqual(['✅ Removed @bob_two.']);
    expect(remove.errs).toEqual([]);

    await expect(store.read()).resolves.toMatchObject({
      allowedUsers: [
        { username: 'alice_one', userId: null, pairedAt: null },
        { username: 'carol_three', userId: null, pairedAt: null },
      ],
    });
    expect(state.ipcCalls.filter((command) => command === 'reload-users')).toHaveLength(3);
  });

  it('explains duplicates, unknown users, invalid names and the last-user rule', async () => {
    const { deps, store } = await configured();
    const duplicate = new FakeIo();
    await expect(runCli(['users', 'add', 'alice_one'], duplicate, deps)).resolves.toBe(1);
    expect(duplicate.errs).toEqual(['❌ @alice_one is already in the list.']);

    const unknown = new FakeIo();
    await expect(runCli(['users', 'unpair', '@nobody_here'], unknown, deps)).resolves.toBe(1);
    expect(unknown.errs).toEqual(['❌ @nobody_here is not in the list.']);

    const invalid = new FakeIo();
    await expect(runCli(['users', 'add', 'x'], invalid, deps)).resolves.toBe(1);
    expect(invalid.errs[0]).toBe('Invalid config:');

    await store.write(validConfig({ allowedUsers: [{ username: 'alice_one', userId: 111, pairedAt: null }] }));
    const last = new FakeIo();
    await expect(runCli(['users', 'remove', 'alice_one'], last, deps)).resolves.toBe(1);
    expect(last.errs).toEqual(['Invalid config:', '- allowedUsers: at least 1 user is required']);

    const usage = new FakeIo();
    await expect(runCli(['users', 'kick', 'alice_one'], usage, deps)).resolves.toBe(1);
    expect(usage.errs[0]).toMatch(/^Usage: agentpager users/);
  });
});

describe('general', () => {
  it('prints the version and help', async () => {
    const { deps } = createTestCli();
    const version = new FakeIo();
    await expect(runCli(['--version'], version, deps)).resolves.toBe(0);
    expect(version.outs).toEqual(['0.1.0']);

    const help = new FakeIo();
    await expect(runCli([], help, deps)).resolves.toBe(0);
    expect(help.outs[0]).toBe('agentpager 0.1.0 — control a coding agent on your computer through Telegram');
    expect(help.outs.some((line) => line.includes('autostart on|off|status'))).toBe(true);
  });

  it('rejects unknown commands with the help text', async () => {
    const { deps } = createTestCli();
    const io = new FakeIo();
    await expect(runCli(['launch'], io, deps)).resolves.toBe(1);
    expect(io.errs[0]).toBe('Unknown command: launch');
    expect(io.errs.length).toBeGreaterThan(5);
  });

  it('runs the hidden daemon command in the background mode', async () => {
    const { deps, state } = createTestCli();
    await expect(runCli(['daemon'], new FakeIo(), deps)).resolves.toBe(0);
    expect(state.foregroundRuns).toEqual([false]);
  });
});
