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
    expect(await screen.findByRole('heading', { name: 'Set up agentpager' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('shows the four sections with live status', async () => {
    fake.api.daemon.status = vi.fn(() => Promise.resolve(ok(runningView())));
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Status' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Navigation' });
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['Status', 'Users', 'Settings', 'Log']);
    expect(await within(nav).findByText('Running')).toBeInTheDocument();

    act(() => {
      fake.emitStatus(daemonView());
    });
    expect(within(nav).getByText('Stopped')).toBeInTheDocument();

    await userEvent.click(within(nav).getByRole('button', { name: 'Users' }));
    expect(screen.getByRole('heading', { name: 'Users' })).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole('button', { name: 'Log' }));
    expect(screen.getByRole('heading', { name: 'Log' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Log' })).toHaveAttribute('aria-current', 'page');
  });

  it('reloads the config when the file changes', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Status' });
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
          issues: ['C:\\agentpager\\config.json is not valid JSON: Unexpected token'],
          fieldErrors: {},
          draft: null,
          users: [],
        }),
      ),
    );
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Run wizard again' }));
    await userEvent.click(screen.getByRole('button', { name: 'Overwrite and run wizard' }));
    expect(screen.getByRole('heading', { name: 'Set up agentpager' })).toBeInTheDocument();
  });

  it('explains a config that cannot be loaded at all', async () => {
    fake.api.config.load = vi.fn(() => Promise.resolve(fail('failed', 'EACCES: permission denied')));
    renderApp();
    expect(await screen.findByText('EACCES: permission denied')).toBeInTheDocument();
    expect(fake.api.config.load).toHaveBeenCalledTimes(1);
    expect(validConfig().state).toBe('valid');
  });

  it('shows a ready update above every screen', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Status' });
    expect(screen.queryByText('New version v0.1.1')).not.toBeInTheDocument();
    act(() => {
      fake.emitUpdate({ kind: 'ready', currentVersion: '0.1.0', version: '0.1.1', notes: null, installError: null });
    });
    expect(screen.getByText('New version v0.1.1')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Users' }));
    expect(screen.getByText('New version v0.1.1')).toBeInTheDocument();
  });
});
