import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../src/renderer/components.js';
import { Wizard } from '../../src/renderer/screens/wizard/Wizard.js';
import { fail, installFakeApi, ok, runningView, user, validConfig, type FakeApi } from './fakeApi.js';

const TOKEN = '123456:ABCdefGHIjklMNOpqrSTUvwx';
let fake: FakeApi;

beforeEach(() => {
  fake = installFakeApi();
});

function renderWizard(overwrite = false) {
  const onDone = vi.fn();
  render(
    <ToastProvider>
      <Wizard overwrite={overwrite} onDone={onDone} />
    </ToastProvider>,
  );
  return { onDone };
}

async function next(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
}

async function passToken(): Promise<void> {
  await userEvent.type(screen.getByLabelText('Token'), TOKEN);
  await userEvent.click(screen.getByRole('button', { name: 'Kiểm tra' }));
  await screen.findByText('✅ @test_bot');
  await next();
}

async function passUsers(names = '@Alice_One'): Promise<void> {
  await userEvent.type(screen.getByLabelText('Username'), `${names}{Enter}`);
  await next();
}

async function reachFinish(): Promise<void> {
  await passToken();
  await passUsers();
  expect(await screen.findByDisplayValue('D:\\Projects')).toBeInTheDocument();
  await next();
  await screen.findByText('🔎 C:\\tools\\claude.exe (2.1.0 (Claude Code))');
  await next();
  await next();
  await screen.findByRole('heading', { name: 'Hoàn tất' });
}

describe('Wizard token step', () => {
  it('continues only with a checked token', async () => {
    renderWizard();
    expect(screen.getByRole('heading', { name: 'Thiết lập agentpager' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Token'), TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Kiểm tra' }));
    expect(await screen.findByText('✅ @test_bot')).toBeInTheDocument();
    expect(fake.api.config.verifyToken).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeEnabled();

    await userEvent.type(screen.getByLabelText('Token'), 'x');
    expect(screen.queryByText('✅ @test_bot')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeDisabled();
  });

  it('tells a rejected token from an unreachable Telegram, which can be skipped after confirming', async () => {
    renderWizard();
    fake.api.config.verifyToken = vi.fn(() => Promise.resolve(fail('invalid_token', 'Token không hợp lệ: 401 Unauthorized')));
    await userEvent.type(screen.getByLabelText('Token'), TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Kiểm tra' }));
    expect(await screen.findByText('Token không hợp lệ: 401 Unauthorized')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeDisabled();

    fake.api.config.verifyToken = vi.fn(() => Promise.resolve(fail('network', 'Không kết nối được Telegram: getaddrinfo ENOTFOUND')));
    await userEvent.click(screen.getByRole('button', { name: 'Kiểm tra' }));
    expect(await screen.findByText(/Không kết nối được Telegram: getaddrinfo ENOTFOUND/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Vẫn tiếp tục' }));
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeEnabled();
  });
});

describe('Wizard users step', () => {
  it('adds normalised chips, rejects invalid names and removes chips', async () => {
    renderWizard();
    await passToken();
    const input = screen.getByLabelText('Username');
    await userEvent.type(input, '@Alice_One, bob_two alice_one{Enter}');
    expect(screen.getByText('@alice_one')).toBeInTheDocument();
    expect(screen.getByText('@bob_two')).toBeInTheDocument();
    expect(input).toHaveValue('');

    await userEvent.type(input, 'carol_three @x{Enter}');
    expect(screen.getByText('Username không hợp lệ: "@x" (5–32 ký tự a-z, 0-9, _)')).toBeInTheDocument();
    expect(screen.queryByText('@carol_three')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Bỏ @alice_one' }));
    expect(screen.queryByText('@alice_one')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Bỏ @bob_two' }));
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeDisabled();
  });
});

describe('Wizard projects and agent steps', () => {
  it('picks folders and CLI files through the system dialogs', async () => {
    fake.api.dialog.pickFolder = vi.fn(() => Promise.resolve(ok<string | null>('E:\\Code')));
    fake.api.dialog.pickExecutable = vi.fn(() => Promise.resolve(ok<string | null>('E:\\bin\\claude.exe')));
    renderWizard();
    await passToken();
    await passUsers();
    await screen.findByDisplayValue('D:\\Projects');
    await userEvent.click(screen.getByRole('button', { name: 'Chọn…' }));
    expect(fake.api.dialog.pickFolder).toHaveBeenCalledWith('D:\\Projects');
    expect(await screen.findByDisplayValue('E:\\Code')).toBeInTheDocument();
    await next();

    await screen.findByText('🔎 C:\\tools\\claude.exe (2.1.0 (Claude Code))');
    await userEvent.click(screen.getByRole('button', { name: 'Chọn file…' }));
    expect(await screen.findByText('🔎 E:\\bin\\claude.exe (2.1.0 (Claude Code))')).toBeInTheDocument();
    expect(fake.api.agent.detect).toHaveBeenLastCalledWith('claude-code', 'E:\\bin\\claude.exe');
    await userEvent.click(screen.getByRole('button', { name: 'Dùng bản tự dò' }));
    expect(await screen.findByText('🔎 C:\\tools\\claude.exe (2.1.0 (Claude Code))')).toBeInTheDocument();
  });

  it('warns when no CLI is found and requires whole minutes', async () => {
    fake.api.agent.detect = vi.fn(() => Promise.resolve(ok({ executable: null, version: null, problems: [] })));
    renderWizard();
    await passToken();
    await passUsers();
    await screen.findByDisplayValue('D:\\Projects');
    await next();
    expect(await screen.findByText(/Không tìm thấy Claude Code CLI trên máy — agent sẽ dùng bản đi kèm SDK/)).toBeInTheDocument();
    await next();
    const minutes = screen.getByLabelText('Số phút');
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '0');
    expect(screen.getByText('Cần số nguyên ≥ 1.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeDisabled();
  });
});

describe('Wizard finish and pairing', () => {
  it('saves, applies both toggles, runs the bot and follows pairing', async () => {
    fake.api.config.load = vi.fn(() => Promise.resolve(ok(validConfig({ users: [user('alice_one')] }))));
    const { onDone } = renderWizard();
    await reachFinish();
    await userEvent.click(screen.getByRole('switch', { name: 'Hiện icon khay khi đăng nhập' }));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu & chạy bot' }));

    expect(await screen.findByRole('heading', { name: 'Ghép tài khoản' })).toBeInTheDocument();
    expect(fake.api.config.runWizard).toHaveBeenCalledWith(
      {
        botToken: TOKEN,
        usernames: ['alice_one'],
        projectsRoot: 'D:\\Projects',
        agent: { provider: 'claude-code', executable: 'C:\\tools\\claude.exe' },
        idleTimeoutMinutes: 60,
      },
      false,
    );
    expect(fake.api.autostart.set).toHaveBeenCalledWith(true);
    expect(fake.api.loginItem.set).toHaveBeenCalledWith(false);
    expect(fake.api.daemon.restart).toHaveBeenCalledTimes(1);
    expect(screen.getByText('@test_bot')).toBeInTheDocument();
    expect(await screen.findByText('đang chờ tin nhắn…')).toBeInTheDocument();

    fake.api.config.load = vi.fn(() => Promise.resolve(ok(validConfig({ users: [user('alice_one', '2026-09-14T10:00:00.000Z')] }))));
    act(() => {
      fake.emitConfigChanged();
    });
    expect(await screen.findByText('✅ đã ghép')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Xong' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('sends field errors back to the step that owns them', async () => {
    fake.api.config.runWizard = vi.fn(() =>
      Promise.resolve(fail('invalid_input', 'Không tìm thấy thư mục: D:\\Projects', { projectsRoot: ['Không tìm thấy thư mục: D:\\Projects'] })),
    );
    renderWizard();
    await reachFinish();
    await userEvent.click(screen.getByRole('button', { name: 'Lưu & chạy bot' }));
    expect(await screen.findByRole('heading', { name: 'Thư mục project' })).toBeInTheDocument();
    expect(screen.getByText('Không tìm thấy thư mục: D:\\Projects')).toBeInTheDocument();
  });

  it('keeps the saved config and retries only the start after a failed start', async () => {
    fake.api.daemon.restart = vi
      .fn()
      .mockResolvedValueOnce(fail('timeout', 'agentpager chưa sẵn sàng sau 20 giây'))
      .mockResolvedValueOnce(ok(runningView()));
    renderWizard();
    await reachFinish();
    await userEvent.click(screen.getByRole('button', { name: 'Lưu & chạy bot' }));
    expect(await screen.findByText('agentpager chưa sẵn sàng sau 20 giây')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quay lại' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thử chạy lại' }));
    expect(await screen.findByRole('heading', { name: 'Ghép tài khoản' })).toBeInTheDocument();
    expect(fake.api.config.runWizard).toHaveBeenCalledTimes(1);
    expect(fake.api.autostart.set).toHaveBeenCalledTimes(1);
  });

  it('leaves machine-wide settings alone for an AGENTPAGER_HOME folder', async () => {
    fake.api.app.info = vi.fn(() => Promise.resolve(ok({ homeOverride: 'C:\\Temp\\ap', platform: 'win32', version: '0.1.0' })));
    renderWizard();
    await reachFinish();
    expect(screen.getByText(/AGENTPAGER_HOME = C:\\Temp\\ap/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lưu & chạy bot' }));
    expect(await screen.findByRole('heading', { name: 'Ghép tài khoản' })).toBeInTheDocument();
    expect(fake.api.autostart.set).not.toHaveBeenCalled();
    expect(fake.api.loginItem.set).not.toHaveBeenCalled();
    expect(fake.api.daemon.restart).toHaveBeenCalledTimes(1);
  });

  it('reports autostart and login item failures on the pairing screen without blocking', async () => {
    fake.api.autostart.set = vi.fn(() => Promise.resolve(fail('failed', 'Access is denied.')));
    renderWizard(true);
    await reachFinish();
    await userEvent.click(screen.getByRole('button', { name: 'Lưu & chạy bot' }));
    expect(await screen.findByText('Tự khởi động: Access is denied.')).toBeInTheDocument();
    expect(fake.api.config.runWizard).toHaveBeenCalledWith(expect.anything(), true);
  });
});
