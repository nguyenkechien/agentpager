import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../src/renderer/components.js';
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen.js';
import type { ConfigView, DaemonView } from '../../src/shared/api.js';
import { daemonView, fail, installFakeApi, ok, runningView, user, validConfig, type FakeApi } from './fakeApi.js';

let fake: FakeApi;

beforeEach(() => {
  fake = installFakeApi();
});

function tree(config: ConfigView, daemon: DaemonView | null, onRunWizard: () => void) {
  return (
    <ToastProvider>
      <SettingsScreen config={config} daemon={daemon} onRunWizard={onRunWizard} />
    </ToastProvider>
  );
}

function renderSettings(config: ConfigView = validConfig(), daemon: DaemonView | null = daemonView()) {
  const onRunWizard = vi.fn();
  const utils = render(tree(config, daemon, onRunWizard));
  return { ...utils, onRunWizard, rerenderWith: (next: ConfigView) => { utils.rerender(tree(next, daemon, onRunWizard)); } };
}

const INVALID: ConfigView = {
  state: 'invalid',
  path: 'C:\\agentpager\\config.json',
  issues: ['idleTimeoutMinutes: phải ≥ 1'],
  fieldErrors: { idleTimeoutMinutes: ['phải ≥ 1'] },
  draft: {
    botTokenMasked: '123456…vwx',
    projectsRoot: 'D:\\Projects',
    idleTimeoutMinutes: 0,
    logLevel: 'info',
    agent: { provider: 'claude-code', executable: null, defaultModel: null, defaultEffort: null },
  },
  users: [user('alice_one')],
};

async function setMinutes(value: string): Promise<void> {
  const input = screen.getByLabelText('Thời gian chờ phiên (phút)');
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

describe('SettingsScreen', () => {
  it('shows the saved settings with the token masked', async () => {
    renderSettings();
    expect(screen.getByText('123456…vwx')).toBeInTheDocument();
    expect(screen.getByLabelText('Thư mục chứa các project')).toHaveValue('D:\\Projects');
    expect(screen.getByLabelText('Thời gian chờ phiên (phút)')).toHaveValue(60);
    expect(screen.getByLabelText('Mức log')).toHaveValue('info');
    expect(await screen.findByRole('option', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lưu' })).toBeDisabled();
  });

  it('saves only the fields that changed', async () => {
    renderSettings();
    await screen.findByRole('option', { name: 'Opus' });
    await setMinutes('90');
    await userEvent.selectOptions(screen.getByLabelText('Model mặc định'), 'opus');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(fake.api.config.save).toHaveBeenCalledWith({ idleTimeoutMinutes: 90, agent: { defaultModel: 'opus' } });
    expect(await screen.findByText('Đã lưu cấu hình.')).toBeInTheDocument();
    expect(screen.queryByText('Restart để áp dụng')).not.toBeInTheDocument();
  });

  it('sends a new token only after "Đổi token"', async () => {
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: 'Đổi token' }));
    await userEvent.type(screen.getByLabelText('Bot token'), '654321:ZYXwvuTSRqpoNMLkjiHGFedc');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(fake.api.config.save).toHaveBeenCalledWith({ botToken: '654321:ZYXwvuTSRqpoNMLkjiHGFedc' });
  });

  it('checks minutes locally and shows core errors under their fields', async () => {
    fake.api.config.save = vi.fn(() =>
      Promise.resolve(fail('invalid_config', 'projectsRoot: phải là đường dẫn tuyệt đối: relative', { projectsRoot: ['phải là đường dẫn tuyệt đối: relative'] })),
    );
    renderSettings();
    await setMinutes('0');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(screen.getByText('Cần số nguyên ≥ 1.')).toBeInTheDocument();
    expect(fake.api.config.save).not.toHaveBeenCalled();

    await setMinutes('30');
    const projects = screen.getByLabelText('Thư mục chứa các project');
    await userEvent.clear(projects);
    await userEvent.type(projects, 'relative');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(fake.api.config.save).toHaveBeenCalledWith({ projectsRoot: 'relative', idleTimeoutMinutes: 30 });
    expect(await screen.findByText('phải là đường dẫn tuyệt đối: relative')).toBeInTheDocument();
  });

  it('asks for a restart when the bot runs with the old settings', async () => {
    renderSettings(validConfig(), runningView());
    await userEvent.selectOptions(screen.getByLabelText('Mức log'), 'debug');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText('Restart để áp dụng')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(fake.api.daemon.restart).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Restart để áp dụng')).not.toBeInTheDocument();
  });

  it('prefills an invalid config and lists its problems', () => {
    renderSettings(INVALID);
    expect(screen.getByText('Cấu hình hiện tại không hợp lệ')).toBeInTheDocument();
    expect(screen.getByText('idleTimeoutMinutes: phải ≥ 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Thời gian chờ phiên (phút)')).toHaveValue(0);
    expect(screen.getByText('phải ≥ 1')).toBeInTheDocument();
  });

  it('offers the file and the wizard for an unparseable config', async () => {
    const { onRunWizard } = renderSettings({ ...INVALID, issues: ['C:\\agentpager\\config.json không phải JSON hợp lệ: Unexpected token'], fieldErrors: {}, draft: null, users: [] });
    expect(screen.queryByRole('button', { name: 'Lưu' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mở file cấu hình' }));
    expect(fake.api.shell.openConfigFile).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Chạy lại wizard' }));
    expect(onRunWizard).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Ghi đè và chạy wizard' }));
    expect(onRunWizard).toHaveBeenCalledTimes(1);
  });

  it('adopts outside changes silently, but asks while editing', async () => {
    const { rerenderWith } = renderSettings();
    rerenderWith(validConfig({ settings: { idleTimeoutMinutes: 45 } }));
    expect(screen.getByLabelText('Thời gian chờ phiên (phút)')).toHaveValue(45);
    expect(screen.queryByText('Cấu hình vừa được thay đổi ở nơi khác')).not.toBeInTheDocument();

    await setMinutes('90');
    rerenderWith(validConfig({ settings: { idleTimeoutMinutes: 45, logLevel: 'warn' } }));
    expect(screen.getByText('Cấu hình vừa được thay đổi ở nơi khác')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Giữ bản đang sửa' }));
    expect(screen.queryByText('Cấu hình vừa được thay đổi ở nơi khác')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Thời gian chờ phiên (phút)')).toHaveValue(90);

    rerenderWith(validConfig({ settings: { idleTimeoutMinutes: 30 } }));
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
    expect(screen.getByLabelText('Thời gian chờ phiên (phút)')).toHaveValue(30);
  });

  it('hides the tray-at-login switch for an AGENTPAGER_HOME folder', async () => {
    fake.api.app.info = vi.fn(() => Promise.resolve(ok({ homeOverride: 'C:\\Temp\\ap' })));
    renderSettings();
    expect(await screen.findByText(/AGENTPAGER_HOME = C:\\Temp\\ap/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Hiện icon khay khi đăng nhập' })).not.toBeInTheDocument();
    expect(fake.api.loginItem.get).not.toHaveBeenCalled();
  });

  it('switches the tray icon at login', async () => {
    fake.api.loginItem.get = vi.fn(() => Promise.resolve(ok(true)));
    renderSettings();
    const toggle = await screen.findByRole('switch', { name: 'Hiện icon khay khi đăng nhập' });
    await vi.waitFor(() => {
      expect(toggle).toBeChecked();
    });
    await userEvent.click(toggle);
    expect(fake.api.loginItem.set).toHaveBeenCalledWith(false);
    expect(toggle).not.toBeChecked();
  });
});
