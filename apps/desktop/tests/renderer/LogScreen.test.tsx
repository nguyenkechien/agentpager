import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { LogScreen } from '../../src/renderer/screens/LogScreen.js';
import type { LogLine } from '../../src/shared/api.js';
import { daemonView, installFakeApi, runningView, type FakeApi } from './fakeApi.js';

let fake: FakeApi;

beforeEach(() => {
  fake = installFakeApi();
});

const line = (message: string, level: LogLine['level'] = 'info', extra: LogLine['extra'] = null): LogLine => ({
  time: new Date(2026, 8, 14, 9, 5, 7).getTime(),
  level,
  message,
  extra,
});

function emit(index: number, lines: LogLine[]): void {
  const subscription = fake.logSubscriptions[index];
  if (!subscription) throw new Error(`no subscription #${String(index)}`);
  act(() => {
    subscription.onLines(lines);
  });
}

function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('LogScreen', () => {
  it('follows the bot log and switches to the supervisor log', async () => {
    render(<LogScreen daemon={runningView()} />);
    expect(fake.logSubscriptions.map((entry) => [entry.source, entry.active])).toEqual([['worker', true]]);
    emit(0, [line('agentpager is polling Telegram'), line('guard blocked a command', 'warn')]);
    expect(screen.getByText('agentpager is polling Telegram')).toBeInTheDocument();
    expect(screen.getByText('WARN')).toBeInTheDocument();
    expect(screen.getAllByText('09:05:07')).toHaveLength(2);

    await userEvent.click(screen.getByRole('tab', { name: 'Supervisor' }));
    expect(fake.logSubscriptions.map((entry) => [entry.source, entry.active])).toEqual([
      ['worker', false],
      ['supervisor', true],
    ]);
    expect(screen.queryByText('agentpager is polling Telegram')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Supervisor' })).toHaveAttribute('aria-selected', 'true');
  });

  it('filters by level and text', async () => {
    render(<LogScreen daemon={runningView()} />);
    emit(0, [line('ready'), line('slow answer', 'warn'), line('polling failed', 'error'), line('    at main.js:1', null)]);
    await userEvent.selectOptions(screen.getByLabelText('Level'), 'warn');
    expect(screen.queryByText('ready')).not.toBeInTheDocument();
    expect(screen.getByText('slow answer')).toBeInTheDocument();
    expect(screen.getByText('at main.js:1', { exact: false })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Level'), 'error');
    expect(screen.queryByText('slow answer')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Level'), 'all');
    await userEvent.type(screen.getByLabelText('Search'), 'ANSWER');
    expect(screen.getByText('slow answer')).toBeInTheDocument();
    expect(screen.queryByText('ready')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search'), 'zzz');
    expect(screen.getByText('No lines match the filter.')).toBeInTheDocument();
  });

  it('shows extra fields on demand and toggles scrolling', async () => {
    render(<LogScreen daemon={runningView()} />);
    emit(0, [line('guard blocked a command', 'warn', { chatId: 7, rule: 'kill-bot' })]);
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/"rule": "kill-bot"/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(screen.queryByText(/"rule": "kill-bot"/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Pause scrolling' }));
    expect(screen.getByRole('button', { name: 'Resume scrolling' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Open log folder' }));
    expect(fake.api.shell.openLogFolder).toHaveBeenCalledTimes(1);
  });

  it('offers Start when there is no log and nothing runs', async () => {
    const { rerender } = render(<LogScreen daemon={runningView()} />);
    expect(screen.getByText('No logs yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    rerender(<LogScreen daemon={daemonView()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(fake.api.daemon.start).toHaveBeenCalledTimes(1);
  });

  it('stops following while the window is hidden and when the screen closes', () => {
    try {
      const { unmount } = render(<LogScreen daemon={runningView()} />);
      setVisibility('hidden');
      expect(fake.logSubscriptions.map((entry) => entry.active)).toEqual([false]);
      setVisibility('visible');
      expect(fake.logSubscriptions.map((entry) => entry.active)).toEqual([false, true]);
      unmount();
      expect(fake.logSubscriptions.map((entry) => entry.active)).toEqual([false, false]);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });
});
