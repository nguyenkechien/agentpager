import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App.js';
import { ToastProvider } from '../../src/renderer/components.js';
import { daemonView, fail, installFakeApi, ok, runningView, validConfig, type FakeApi } from './fakeApi.js';

let fake: FakeApi;

beforeEach(() => {
  fake = installFakeApi();
});

function renderApp() {
  return render(
    <ToastProvider>
      <App />
    </ToastProvider>,
  );
}

describe('App', () => {
  it('opens the wizard when there is no config', async () => {
    fake.api.config.load = vi.fn(() => Promise.resolve(ok({ state: 'missing' as const, path: 'C:\\agentpager\\config.json' })));
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Thiết lập agentpager' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('shows the four sections with live status', async () => {
    fake.api.daemon.status = vi.fn(() => Promise.resolve(ok(runningView())));
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Trạng thái' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Điều hướng' });
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['Trạng thái', 'Người dùng', 'Cài đặt', 'Log']);
    expect(await within(nav).findByText('Đang chạy')).toBeInTheDocument();

    act(() => {
      fake.emitStatus(daemonView());
    });
    expect(within(nav).getByText('Đã dừng')).toBeInTheDocument();

    await userEvent.click(within(nav).getByRole('button', { name: 'Người dùng' }));
    expect(screen.getByRole('heading', { name: 'Người dùng' })).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole('button', { name: 'Cài đặt' }));
    expect(screen.getByRole('heading', { name: 'Cài đặt' })).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole('button', { name: 'Log' }));
    expect(screen.getByRole('heading', { name: 'Log' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Log' })).toHaveAttribute('aria-current', 'page');
  });

  it('reloads the config when the file changes', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Trạng thái' });
    expect(fake.api.config.load).toHaveBeenCalledTimes(1);
    act(() => {
      fake.emitConfigChanged();
    });
    await vi.waitFor(() => {
      expect(fake.api.config.load).toHaveBeenCalledTimes(2);
    });
  });

  it('runs the wizard again from Settings over an unreadable config', async () => {
    fake.api.config.load = vi.fn(() =>
      Promise.resolve(
        ok({
          state: 'invalid' as const,
          path: 'C:\\agentpager\\config.json',
          issues: ['C:\\agentpager\\config.json không phải JSON hợp lệ: Unexpected token'],
          fieldErrors: {},
          draft: null,
          users: [],
        }),
      ),
    );
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Cài đặt' }));
    await userEvent.click(screen.getByRole('button', { name: 'Chạy lại wizard' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ghi đè và chạy wizard' }));
    expect(screen.getByRole('heading', { name: 'Thiết lập agentpager' })).toBeInTheDocument();
  });

  it('explains a config that cannot be loaded at all', async () => {
    fake.api.config.load = vi.fn(() => Promise.resolve(fail('failed', 'EACCES: permission denied')));
    renderApp();
    expect(await screen.findByText('EACCES: permission denied')).toBeInTheDocument();
    expect(fake.api.config.load).toHaveBeenCalledTimes(1);
    expect(validConfig().state).toBe('valid');
  });
});
