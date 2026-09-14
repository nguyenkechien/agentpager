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
    expect(io.asked[0]).toEqual({ question: 'Bot token từ @BotFather: ', hidden: true });
    expect(io.outs).toEqual([
      '✅ Bot @test_bot',
      'Agent: Fake Agent',
      '🔎 Fake Agent CLI: C:\\tools\\claude.exe (2.1.0 (Claude Code))',
      `✅ Đã lưu cấu hình: ${deps.paths.config}`,
      '👉 Nhắn một tin bất kỳ cho @test_bot từ @alice_one, @bob_two để ghép tài khoản.',
      'Đã bật tự khởi động agentpager.',
      '✅ agentpager đang chạy · bot @test_bot · pid 4242',
    ]);
    expect(state.autostartCalls).toEqual([
      'enable:C:\\Program Files\\nodejs\\node.exe|C:\\npm\\node_modules\\agentpager\\dist\\cli\\main.js daemon|C:\\Users\\alex|true',
    ]);
    expect(state.spawned).toBe(1);
  });

  it('defaults the projects root to the home folder on macOS without ~/Projects and uses the bundled CLI', async () => {
    const { deps, state, store } = createTestCli({
      platform: 'darwin',
      detection: { executable: null, version: null, problems: ['Không tìm thấy Claude Code CLI'] },
    });
    state.existing.add('/Users/alex');
    const io = new FakeIo([TOKEN, 'alice_one', '', '', '30'], [false, false]);
    await expect(runCli(['setup'], io, deps)).resolves.toBe(0);
    await expect(store.read()).resolves.toMatchObject({
      projectsRoot: '/Users/alex',
      idleTimeoutMinutes: 30,
      agent: { executable: null },
    });
    expect(io.outs).toContain('  ⚠️ Không tìm thấy Claude Code CLI');
    expect(io.asked[3]?.question).toBe('Đường dẫn CLI (Enter để dùng bản đi kèm SDK): ');
  });

  it('keeps an existing config unless the user confirms overwriting it', async () => {
    const { deps, store } = createTestCli();
    await store.write(validConfig());
    const io = new FakeIo([], [false]);
    await expect(runCli(['setup'], io, deps)).resolves.toBe(0);
    expect(io.confirmed).toEqual([`Đã có cấu hình tại ${deps.paths.config}. Ghi đè?`]);
    expect(io.outs).toEqual(['Giữ nguyên cấu hình hiện tại.']);
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
      '❌ Token không đúng định dạng <số>:<chuỗi> của BotFather.',
      '❌ Token không dùng được: 401: Unauthorized',
      '❌ Cần ít nhất 1 username.',
      expect.stringMatching(/^❌ Username không hợp lệ: "abc"/),
      '❌ Không tìm thấy thư mục: E:\\missing',
      '❌ Cần đường dẫn tuyệt đối: relative',
      '❌ Không tìm thấy file: E:\\nope.exe',
      '❌ Cần số nguyên ≥ 1.',
    ]);
  });

  it('skips autostart for an AGENTPAGER_HOME folder', async () => {
    const { deps, state } = createTestCli();
    deps.platform = { ...deps.platform, env: { AGENTPAGER_HOME: 'D:\\tmp\\ap' } };
    state.existing.add('D:\\Projects');
    const io = new FakeIo([TOKEN, 'alice_one', '', '', ''], [false]);
    await expect(runCli(['setup'], io, deps)).resolves.toBe(0);
    expect(io.outs).toContain(
      'ℹ️ Bỏ qua tự khởi động: Tự khởi động là thiết lập chung của máy và không mang theo AGENTPAGER_HOME (D:\\tmp\\ap) — bỏ AGENTPAGER_HOME để bật/tắt.',
    );
    expect(io.confirmed).toEqual(['Chạy agentpager ngay?']);
    expect(state.autostartCalls).toEqual([]);
  });

  it('offers a restart instead of a start when the daemon already runs', async () => {
    const { deps, state } = createTestCli();
    state.existing.add('D:\\Projects');
    state.daemon = runningStatus();
    const io = new FakeIo([TOKEN, 'alice_one', '', '', ''], [false, true]);
    await expect(runCli(['setup'], io, deps)).resolves.toBe(0);
    expect(io.confirmed.at(-1)).toBe('agentpager đang chạy. Khởi động lại để áp dụng cấu hình mới?');
    expect(state.ipcCalls).toContain('restart');
  });
});
