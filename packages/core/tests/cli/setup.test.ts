import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { createTestCli, DETECTED, FakeIo, runningStatus, TOKEN, validConfig } from './support.js';

describe('setup', () => {
  it('walks through the wizard, writes the config, enables autostart and starts the daemon', async () => {
    const { deps, state, store } = createTestCli();
    state.existing.add('D:\\Projects');
    state.onSpawn = () => {
      state.daemon = runningStatus();
    };
    const io = new FakeIo([TOKEN, '@Alice_One, bob_two, alice_one', '', '', ''], [true, true]);

    await expect(runCli(['setup'], io, deps)).resolves.toBe(0);

    await expect(store.read()).resolves.toEqual({
      version: 1,
      telegram: { botToken: TOKEN },
      allowedUsers: [
        { username: 'alice_one', userId: null, pairedAt: null },
        { username: 'bob_two', userId: null, pairedAt: null },
      ],
      projectsRoot: 'D:\\Projects',
      idleTimeoutMinutes: 60,
      logLevel: 'info',
      agent: { provider: 'fake', executable: DETECTED.executable, defaultModel: null, defaultEffort: null },
    });
    expect(io.asked[0]).toEqual({ question: 'Bot token from @BotFather: ', hidden: true });
    expect(io.outs).toEqual([
      '✅ Bot @test_bot',
      'Agent: Fake Agent',
      '🔎 Fake Agent CLI: C:\\tools\\claude.exe (2.1.0 (Claude Code))',
      `✅ Config saved: ${deps.paths.config}`,
      '👉 Send any message to @test_bot from @alice_one, @bob_two to pair the account.',
      'Enabled agentpager autostart.',
      '✅ agentpager is running · bot @test_bot · pid 4242',
    ]);
    expect(state.autostartCalls).toEqual([
      'enable:C:\\Program Files\\nodejs\\node.exe|C:\\npm\\node_modules\\agentpager\\dist\\cli\\main.js daemon|C:\\Users\\alex|true',
    ]);
    expect(state.spawned).toBe(1);
  });

  it('defaults the projects root to the home folder on macOS without ~/Projects and uses the bundled CLI', async () => {
    const { deps, state, store } = createTestCli({
      platform: 'darwin',
      detection: { executable: null, version: null, problems: ['Claude Code CLI not found'] },
    });
    state.existing.add('/Users/alex');
    const io = new FakeIo([TOKEN, 'alice_one', '', '', '30'], [false, false]);
    await expect(runCli(['setup'], io, deps)).resolves.toBe(0);
    await expect(store.read()).resolves.toMatchObject({
      projectsRoot: '/Users/alex',
      idleTimeoutMinutes: 30,
      agent: { executable: null },
    });
    expect(io.outs).toContain('  ⚠️ Claude Code CLI not found');
    expect(io.asked[3]?.question).toBe('CLI path (Enter to use the one bundled with the SDK): ');
  });

  it('keeps an existing config unless the user confirms overwriting it', async () => {
    const { deps, store } = createTestCli();
    await store.write(validConfig());
    const io = new FakeIo([], [false]);
    await expect(runCli(['setup'], io, deps)).resolves.toBe(0);
    expect(io.confirmed).toEqual([`A config already exists at ${deps.paths.config}. Overwrite it?`]);
    expect(io.outs).toEqual(['Keeping the current config.']);
    expect(io.asked).toEqual([]);
  });

  it('asks again after an unusable token, invalid usernames, a missing folder or a bad number', async () => {
    const { deps, state, store } = createTestCli();
    const revoked = '999999:revokedrevokedrevokedrevoked';
    state.invalidTokens.add(revoked);
    state.existing.add('E:\\work');
    state.existing.add('E:\\bin\\claude.exe');
    const io = new FakeIo(
      ['not-a-token', revoked, TOKEN, '', 'abc', '@valid_user', 'E:\\missing', 'relative', 'E:\\work', 'E:\\nope.exe', 'E:\\bin\\claude.exe', '0', '15'],
      [false, false],
    );

    await expect(runCli(['setup'], io, deps)).resolves.toBe(0);
    await expect(store.read()).resolves.toMatchObject({
      allowedUsers: [{ username: 'valid_user', userId: null, pairedAt: null }],
      projectsRoot: 'E:\\work',
      idleTimeoutMinutes: 15,
      agent: { executable: 'E:\\bin\\claude.exe' },
    });
    expect(io.errs).toEqual([
      '❌ The token is not in the BotFather format <number>:<string>.',
      '❌ The token does not work: 401: Unauthorized',
      '❌ At least 1 username is required.',
      expect.stringMatching(/^❌ Invalid username: "abc"/),
      '❌ Folder not found: E:\\missing',
      '❌ An absolute path is required: relative',
      '❌ File not found: E:\\nope.exe',
      '❌ An integer ≥ 1 is required.',
    ]);
  });

  it('skips autostart for an AGENTPAGER_HOME folder', async () => {
    const { deps, state } = createTestCli();
    deps.platform = { ...deps.platform, env: { AGENTPAGER_HOME: 'D:\\tmp\\ap' } };
    state.existing.add('D:\\Projects');
    const io = new FakeIo([TOKEN, 'alice_one', '', '', ''], [false]);
    await expect(runCli(['setup'], io, deps)).resolves.toBe(0);
    expect(io.outs).toContain(
      'ℹ️ Skipping autostart: Autostart is a machine-wide setting and does not carry AGENTPAGER_HOME (D:\\tmp\\ap) — unset AGENTPAGER_HOME to turn it on or off.',
    );
    expect(io.confirmed).toEqual(['Start agentpager now?']);
    expect(state.autostartCalls).toEqual([]);
  });

  it('offers a restart instead of a start when the daemon already runs', async () => {
    const { deps, state } = createTestCli();
    state.existing.add('D:\\Projects');
    state.daemon = runningStatus();
    const io = new FakeIo([TOKEN, 'alice_one', '', '', ''], [false, true]);
    await expect(runCli(['setup'], io, deps)).resolves.toBe(0);
    expect(io.confirmed.at(-1)).toBe('agentpager is running. Restart it to apply the new config?');
    expect(state.ipcCalls).toContain('restart');
  });
});
