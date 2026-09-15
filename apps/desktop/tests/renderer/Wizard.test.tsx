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
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
}

async function passToken(): Promise<void> {
  await userEvent.type(screen.getByLabelText('Token'), TOKEN);
  await userEvent.click(screen.getByRole('button', { name: 'Check' }));
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
  await screen.findByRole('heading', { name: 'Finish' });
}

describe('Wizard token step', () => {
  it('continues only with a checked token', async () => {
    renderWizard();
    expect(screen.getByRole('heading', { name: 'Set up agentpager' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Token'), TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('✅ @test_bot')).toBeInTheDocument();
    expect(fake.api.config.verifyToken).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();

    await userEvent.type(screen.getByLabelText('Token'), 'x');
    expect(screen.queryByText('✅ @test_bot')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('tells a rejected token from an unreachable Telegram, which can be skipped after confirming', async () => {
    renderWizard();
    fake.api.config.verifyToken = vi.fn(() => Promise.resolve(fail('invalid_token', 'Invalid token: 401 Unauthorized')));
    await userEvent.type(screen.getByLabelText('Token'), TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Invalid token: 401 Unauthorized')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    fake.api.config.verifyToken = vi.fn(() => Promise.resolve(fail('network', 'Could not connect to Telegram: getaddrinfo ENOTFOUND')));
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText(/Could not connect to Telegram: getaddrinfo ENOTFOUND/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
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
    expect(screen.getByText('Invalid username: "@x" (5–32 characters a-z, 0-9, _)')).toBeInTheDocument();
    expect(screen.queryByText('@carol_three')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove @alice_one' }));
    expect(screen.queryByText('@alice_one')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove @bob_two' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
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
    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(fake.api.dialog.pickFolder).toHaveBeenCalledWith('D:\\Projects');
    expect(await screen.findByDisplayValue('E:\\Code')).toBeInTheDocument();
    await next();

    await screen.findByText('🔎 C:\\tools\\claude.exe (2.1.0 (Claude Code))');
    await userEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
    expect(await screen.findByText('🔎 E:\\bin\\claude.exe (2.1.0 (Claude Code))')).toBeInTheDocument();
    expect(fake.api.agent.detect).toHaveBeenLastCalledWith('claude-code', 'E:\\bin\\claude.exe');
    await userEvent.click(screen.getByRole('button', { name: 'Use auto-detected' }));
    expect(await screen.findByText('🔎 C:\\tools\\claude.exe (2.1.0 (Claude Code))')).toBeInTheDocument();
  });

  it('warns when no CLI is found and requires whole minutes', async () => {
    fake.api.agent.detect = vi.fn(() => Promise.resolve(ok({ executable: null, version: null, problems: [] })));
    renderWizard();
    await passToken();
    await passUsers();
    await screen.findByDisplayValue('D:\\Projects');
    await next();
    expect(await screen.findByText(/Claude Code CLI was not found on this machine — the agent will use the one bundled with the SDK/)).toBeInTheDocument();
    await next();
    const minutes = screen.getByLabelText('Minutes');
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '0');
    expect(screen.getByText('Must be a whole number ≥ 1.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

describe('Wizard finish and pairing', () => {
  it('saves, applies both toggles, runs the bot and follows pairing', async () => {
    fake.api.config.load = vi.fn(() => Promise.resolve(ok(validConfig({ users: [user('alice_one')] }))));
    const { onDone } = renderWizard();
    await reachFinish();
    await userEvent.click(screen.getByRole('switch', { name: 'Show tray icon at login' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save & start bot' }));

    expect(await screen.findByRole('heading', { name: 'Pair accounts' })).toBeInTheDocument();
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
    expect(await screen.findByText('waiting for a message…')).toBeInTheDocument();

    fake.api.config.load = vi.fn(() => Promise.resolve(ok(validConfig({ users: [user('alice_one', '2026-09-14T10:00:00.000Z')] }))));
    act(() => {
      fake.emitConfigChanged();
    });
    expect(await screen.findByText('✅ paired')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('sends field errors back to the step that owns them', async () => {
    fake.api.config.runWizard = vi.fn(() =>
      Promise.resolve(fail('invalid_input', 'Folder not found: D:\\Projects', { projectsRoot: ['Folder not found: D:\\Projects'] })),
    );
    renderWizard();
    await reachFinish();
    await userEvent.click(screen.getByRole('button', { name: 'Save & start bot' }));
    expect(await screen.findByRole('heading', { name: 'Projects folder' })).toBeInTheDocument();
    expect(screen.getByText('Folder not found: D:\\Projects')).toBeInTheDocument();
  });

  it('keeps the saved config and retries only the start after a failed start', async () => {
    fake.api.daemon.restart = vi
      .fn()
      .mockResolvedValueOnce(fail('timeout', 'agentpager was not ready after 20 seconds'))
      .mockResolvedValueOnce(ok(runningView()));
    renderWizard();
    await reachFinish();
    await userEvent.click(screen.getByRole('button', { name: 'Save & start bot' }));
    expect(await screen.findByText('agentpager was not ready after 20 seconds')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try starting again' }));
    expect(await screen.findByRole('heading', { name: 'Pair accounts' })).toBeInTheDocument();
    expect(fake.api.config.runWizard).toHaveBeenCalledTimes(1);
    expect(fake.api.autostart.set).toHaveBeenCalledTimes(1);
  });

  it('leaves machine-wide settings alone for an AGENTPAGER_HOME folder', async () => {
    fake.api.app.info = vi.fn(() => Promise.resolve(ok({ homeOverride: 'C:\\Temp\\ap', platform: 'win32', version: '0.1.0' })));
    renderWizard();
    await reachFinish();
    expect(screen.getByText(/AGENTPAGER_HOME = C:\\Temp\\ap/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save & start bot' }));
    expect(await screen.findByRole('heading', { name: 'Pair accounts' })).toBeInTheDocument();
    expect(fake.api.autostart.set).not.toHaveBeenCalled();
    expect(fake.api.loginItem.set).not.toHaveBeenCalled();
    expect(fake.api.daemon.restart).toHaveBeenCalledTimes(1);
  });

  it('reports autostart and login item failures on the pairing screen without blocking', async () => {
    fake.api.autostart.set = vi.fn(() => Promise.resolve(fail('failed', 'Access is denied.')));
    renderWizard(true);
    await reachFinish();
    await userEvent.click(screen.getByRole('button', { name: 'Save & start bot' }));
    expect(await screen.findByText('Autostart: Access is denied.')).toBeInTheDocument();
    expect(fake.api.config.runWizard).toHaveBeenCalledWith(expect.anything(), true);
  });
});
