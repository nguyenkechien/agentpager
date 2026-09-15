import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../src/renderer/components.js';
import { StatusScreen } from '../../src/renderer/screens/StatusScreen.js';
import type { ApiResult, AutostartView, BadgeState, DaemonView } from '../../src/shared/api.js';
import { AUTOSTART_OFF, daemonView, fail, installFakeApi, ok, runningView, validConfig, type FakeApi } from './fakeApi.js';

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
      running: 'Running',
      starting: 'Starting',
      restarting: 'Restarting',
      stopped: 'Stopped',
      error: 'Error',
      unresponsive: 'Bot not responding',
      disconnected: 'Disconnected',
    };
    const { rerender } = renderStatus(null);
    expect(screen.getByTestId('badge')).toHaveTextContent('Reading status…');
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
    renderStatus(runningView({ restarts: 2, lastError: 'Worker exited unexpectedly (code 1)' }));
    expect(screen.getByText('@test_bot')).toBeInTheDocument();
    expect(screen.getByText('4242')).toBeInTheDocument();
    expect(screen.getByText('2 hours 5 minutes')).toBeInTheDocument();
    expect(screen.getByText('2 times')).toBeInTheDocument();
    expect(screen.getByText('Worker exited unexpectedly (code 1)')).toBeInTheDocument();
    expect(screen.getByText('agentpager app')).toBeInTheDocument();
    expect(await screen.findByText('C:\\tools\\claude.exe (2.1.0 (Claude Code))')).toBeInTheDocument();
    expect(fake.api.agent.detect).toHaveBeenCalledWith('claude-code', null);
  });

  it('names where the daemon was started from, including 0.1.x daemons that do not record it', () => {
    const { rerender } = renderStatus(runningView({ launcher: { kind: 'cli', executable: 'C:\\npm\\agentpager\\dist\\cli\\main.js' } }));
    expect(screen.getByText('agentpager cli')).toBeInTheDocument();
    rerender(
      <ToastProvider>
        <StatusScreen daemon={runningView({ launcher: null })} config={validConfig()} onNavigate={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.getByText('agentpager cli (0.1.x)')).toBeInTheDocument();
  });

  it('allows Start only when nothing runs, and Stop/Restart only when something does', () => {
    const { rerender } = renderStatus(runningView());
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled();
    rerender(
      <ToastProvider>
        <StatusScreen daemon={daemonView({ badge: 'error', lastError: 'No config yet — run "agentpager setup".' })} config={validConfig()} onNavigate={vi.fn()} />
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
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    finish(ok(runningView()));
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('explains a fatal start and offers to change the token', async () => {
    fake.api.daemon.start = vi.fn(() => Promise.resolve(fail('fatal', 'Invalid Telegram token (401 Unauthorized)')));
    const { onNavigate } = renderStatus(daemonView());
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Invalid Telegram token (401 Unauthorized)', { selector: '.banner-text' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Change token' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
  });

  it('offers the log folder for other failures and for a bot that does not answer', async () => {
    fake.api.daemon.start = vi.fn(() => Promise.resolve(fail('timeout', 'agentpager was not ready after 20 seconds — see the logs in C:\\logs')));
    const { rerender } = renderStatus(daemonView());
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open log folder' }));
    expect(fake.api.shell.openLogFolder).toHaveBeenCalledTimes(1);

    rerender(
      <ToastProvider>
        <StatusScreen daemon={daemonView({ badge: 'unresponsive', pid: 42 })} config={validConfig()} onNavigate={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.getByText('The daemon is still running but not answering. Check the log to see what it is doing.')).toBeInTheDocument();
  });

  it('shows the autostart switch only once it is read, and flips it at once while applying', async () => {
    let finishGet: (result: ApiResult<AutostartView>) => void = () => undefined;
    fake.api.autostart.get = vi.fn(
      () =>
        new Promise<ApiResult<AutostartView>>((resolve) => {
          finishGet = resolve;
        }),
    );
    let finishSet: (result: ApiResult<AutostartView>) => void = () => undefined;
    fake.api.autostart.set = vi.fn(
      () =>
        new Promise<ApiResult<AutostartView>>((resolve) => {
          finishSet = resolve;
        }),
    );
    renderStatus(runningView());
    expect(screen.getByText('Reading autostart status…')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();

    await vi.waitFor(() => {
      expect(fake.api.autostart.get).toHaveBeenCalledTimes(1);
    });
    finishGet(ok(AUTOSTART_OFF));
    const toggle = await screen.findByRole('switch', { name: 'Start the bot at login' });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(screen.getByText('Applying…')).toBeInTheDocument();

    finishSet(ok({ enabled: true, command: ['C:\\agentpager\\agentpager.exe', '--daemon'], ownedByThisApp: true, problems: [] }));
    await vi.waitFor(() => {
      expect(screen.queryByText('Applying…')).not.toBeInTheDocument();
    });
    expect(toggle).toBeChecked();
  });

  it('explains that autostart is machine-wide when AGENTPAGER_HOME is set', async () => {
    fake.api.app.info = vi.fn(() => Promise.resolve(ok({ homeOverride: 'C:\\Temp\\ap', platform: 'win32', version: '0.1.0' })));
    renderStatus(runningView());
    expect(await screen.findByText(/AGENTPAGER_HOME = C:\\Temp\\ap/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(fake.api.autostart.get).not.toHaveBeenCalled();
  });

  it('puts the autostart toggle back and explains when changing it fails', async () => {
    fake.api.autostart.set = vi.fn(() => Promise.resolve(fail('failed', 'Access is denied.')));
    renderStatus(runningView());
    const toggle = await screen.findByRole('switch', { name: 'Start the bot at login' });
    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    await userEvent.click(toggle);
    expect(await screen.findByText('Could not change autostart: Access is denied.')).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });

  it('offers to repair autostart or move it to this app', async () => {
    fake.api.autostart.get = vi.fn(() =>
      Promise.resolve(
        ok({ enabled: true, command: ['C:\\node\\node.exe', 'C:\\npm\\agentpager\\dist\\cli\\main.js', 'daemon'], ownedByThisApp: false, problems: [] }),
      ),
    );
    const { unmount } = renderStatus(runningView());
    await userEvent.click(await screen.findByRole('button', { name: 'Switch autostart to this app' }));
    expect(fake.api.autostart.set).toHaveBeenCalledWith(true);
    unmount();

    fake.api.autostart.get = vi.fn(() =>
      Promise.resolve(ok({ enabled: true, command: ['C:\\old\\agentpager.exe', '--daemon'], ownedByThisApp: false, problems: ['No longer exists: C:\\old\\agentpager.exe'] })),
    );
    renderStatus(runningView());
    expect(await screen.findByText('No longer exists: C:\\old\\agentpager.exe')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch autostart to this app' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fix autostart' }));
    expect(fake.api.autostart.set).toHaveBeenCalledTimes(2);
  });
});

describe('StatusScreen switching from the cli', () => {
  const cliLauncher = { kind: 'cli' as const, executable: 'main.js' };

  it('moves a bot started by the cli to the app after confirming', async () => {
    renderStatus(runningView({ launcher: cliLauncher }));
    expect(screen.getByText('The bot is running from agentpager cli')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run the bot from this app' }));
    expect(screen.getByText('The bot will stop for a few seconds, then start again from agentpager app.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Switch' }));
    await waitFor(() => {
      expect(fake.api.daemon.switchToApp).toHaveBeenCalledTimes(1);
    });
  });

  it('treats a 0.1.x daemon without a launcher as the cli, and says nothing for the app', () => {
    const { rerender } = renderStatus(runningView({ launcher: null }));
    expect(screen.getByRole('button', { name: 'Run the bot from this app' })).toBeInTheDocument();
    rerender(
      <ToastProvider>
        <StatusScreen daemon={runningView()} config={validConfig()} onNavigate={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Run the bot from this app' })).not.toBeInTheDocument();
  });
});
