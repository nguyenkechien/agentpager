import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../src/renderer/components.js';
import { StatusScreen } from '../../src/renderer/screens/StatusScreen.js';
import type { ApiResult, BadgeState, DaemonView } from '../../src/shared/api.js';
import { daemonView, fail, installFakeApi, ok, runningView, validConfig, type FakeApi } from './fakeApi.js';

let fake: FakeApi;

beforeEach(() => {
  fake = installFakeApi();
});

function renderStatus(daemon: DaemonView | null, onNavigate = vi.fn()) {
  const result = render(
    <ToastProvider>
      <StatusScreen daemon={daemon} config={validConfig()} onNavigate={onNavigate} />
    </ToastProvider>,
  );
  return { ...result, onNavigate };
}

describe('StatusScreen', () => {
  it('names every daemon state', () => {
    const labels: Record<BadgeState, string> = {
      running: 'Đang chạy',
      starting: 'Đang khởi động',
      restarting: 'Đang khởi động lại',
      stopped: 'Đã dừng',
      error: 'Lỗi',
      unresponsive: 'Bot không phản hồi',
      disconnected: 'Mất kết nối',
    };
    const { rerender } = renderStatus(null);
    expect(screen.getByTestId('badge')).toHaveTextContent('Đang đọc trạng thái…');
    for (const [badge, label] of Object.entries(labels) as [BadgeState, string][]) {
      rerender(
        <ToastProvider>
          <StatusScreen daemon={daemonView({ badge })} config={validConfig()} onNavigate={vi.fn()} />
        </ToastProvider>,
      );
      expect(screen.getByTestId('badge')).toHaveTextContent(label);
    }
  });

  it('shows the running bot details', async () => {
    renderStatus(runningView({ restarts: 2, lastError: 'Worker thoát bất thường (code 1)' }));
    expect(screen.getByText('@test_bot')).toBeInTheDocument();
    expect(screen.getByText('4242')).toBeInTheDocument();
    expect(screen.getByText('2 giờ 5 phút')).toBeInTheDocument();
    expect(screen.getByText('2 lần')).toBeInTheDocument();
    expect(screen.getByText('Worker thoát bất thường (code 1)')).toBeInTheDocument();
    expect(screen.getByText('chạy từ app')).toBeInTheDocument();
    expect(await screen.findByText('C:\\tools\\claude.exe (2.1.0 (Claude Code))')).toBeInTheDocument();
    expect(fake.api.agent.detect).toHaveBeenCalledWith('claude-code', null);
  });

  it('allows Start only when nothing runs, and Stop/Restart only when something does', () => {
    const { rerender } = renderStatus(runningView());
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled();
    rerender(
      <ToastProvider>
        <StatusScreen daemon={daemonView({ badge: 'error', lastError: 'Chưa có cấu hình' })} config={validConfig()} onNavigate={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeDisabled();
  });

  it('shows progress while starting', async () => {
    let finish: (result: ApiResult<DaemonView>) => void = () => undefined;
    fake.api.daemon.start = vi.fn(
      () =>
        new Promise<ApiResult<DaemonView>>((resolve) => {
          finish = resolve;
        }),
    );
    renderStatus(daemonView());
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(screen.getByRole('button', { name: 'Đang khởi động…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    finish(ok(runningView()));
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('explains a fatal start and offers to change the token', async () => {
    fake.api.daemon.start = vi.fn(() => Promise.resolve(fail('fatal', 'Token Telegram không hợp lệ (401 Unauthorized)')));
    const { onNavigate } = renderStatus(daemonView());
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Token Telegram không hợp lệ (401 Unauthorized)', { selector: '.banner-text' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Đổi token' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
  });

  it('offers the log folder for other failures and for a bot that does not answer', async () => {
    fake.api.daemon.start = vi.fn(() => Promise.resolve(fail('timeout', 'agentpager chưa sẵn sàng sau 20 giây — xem log trong C:\\logs')));
    const { rerender } = renderStatus(daemonView());
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mở thư mục log' }));
    expect(fake.api.shell.openLogFolder).toHaveBeenCalledTimes(1);

    rerender(
      <ToastProvider>
        <StatusScreen daemon={daemonView({ badge: 'unresponsive', pid: 42 })} config={validConfig()} onNavigate={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.getByText('Daemon vẫn đang chạy nhưng không trả lời. Xem log để biết nó đang làm gì.')).toBeInTheDocument();
  });

  it('puts the autostart toggle back and explains when changing it fails', async () => {
    fake.api.autostart.set = vi.fn(() => Promise.resolve(fail('failed', 'Access is denied.')));
    renderStatus(runningView());
    const toggle = await screen.findByRole('switch', { name: 'Tự khởi động bot khi đăng nhập' });
    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    await userEvent.click(toggle);
    expect(await screen.findByText('Không đổi được tự khởi động: Access is denied.')).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });

  it('offers to repair autostart or move it to this app', async () => {
    fake.api.autostart.get = vi.fn(() =>
      Promise.resolve(
        ok({ enabled: true, command: ['C:\\node\\node.exe', 'C:\\npm\\agentpager\\dist\\cli\\main.js', 'daemon'], ownedByThisApp: false, problems: [] }),
      ),
    );
    const { unmount } = renderStatus(runningView());
    await userEvent.click(await screen.findByRole('button', { name: 'Chuyển tự khởi động sang app này' }));
    expect(fake.api.autostart.set).toHaveBeenCalledWith(true);
    unmount();

    fake.api.autostart.get = vi.fn(() =>
      Promise.resolve(ok({ enabled: true, command: ['C:\\old\\agentpager.exe', '--daemon'], ownedByThisApp: false, problems: ['Không còn tìm thấy C:\\old\\agentpager.exe'] })),
    );
    renderStatus(runningView());
    expect(await screen.findByText('Không còn tìm thấy C:\\old\\agentpager.exe')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chuyển tự khởi động sang app này' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sửa tự khởi động' }));
    expect(fake.api.autostart.set).toHaveBeenCalledTimes(2);
  });
});
