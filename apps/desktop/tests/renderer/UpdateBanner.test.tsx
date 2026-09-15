import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from '../../src/renderer/UpdateBanner.js';
import type { InstallResult, UpdateView } from '../../src/shared/api.js';
import { fail, installFakeApi, ok, type FakeApi } from './fakeApi.js';

let fake: FakeApi;

beforeEach(() => {
  fake = installFakeApi();
});

const READY: UpdateView = { kind: 'ready', currentVersion: '0.1.0', version: '0.1.1', notes: null, installError: null };

function answer(...results: InstallResult[]): void {
  const queue = [...results];
  const installing: InstallResult = { kind: 'installing' };
  fake.api.update.install = vi.fn(() => Promise.resolve(ok<InstallResult>(queue.shift() ?? installing)));
}

describe('UpdateBanner', () => {
  it('shows nothing without an update', () => {
    const { container } = render(<UpdateBanner view={{ kind: 'idle', currentVersion: '0.1.0', checkedAt: null }} />);
    expect(container).toBeEmptyDOMElement();
    render(<UpdateBanner view={null} />);
  });

  it('installs a ready update when the agent is idle', async () => {
    answer({ kind: 'installing' });
    render(<UpdateBanner view={READY} />);
    expect(screen.getByText('Có bản mới v0.1.1')).toBeInTheDocument();
    expect(screen.getByText('Bot sẽ dừng khoảng nửa phút rồi chạy lại.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
    expect(fake.api.update.install).toHaveBeenCalledWith('ask');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks while the agent is busy and can wait until it is idle', async () => {
    answer({ kind: 'busy', activeTurns: 1, queuedInputs: 2 }, { kind: 'waiting' });
    render(<UpdateBanner view={READY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
    const dialog = await screen.findByRole('dialog', { name: 'Agent đang bận' });
    expect(dialog).toHaveTextContent('Agent đang chạy 1 lượt và còn 2 tin chờ.');
    expect(screen.getByRole('button', { name: 'Cập nhật khi rảnh' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cập nhật khi rảnh' }));
    expect(fake.api.update.install).toHaveBeenLastCalledWith('when_idle');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('installs now or cancels from the busy dialog', async () => {
    answer({ kind: 'busy', activeTurns: 0, queuedInputs: 1 }, { kind: 'busy', activeTurns: 2, queuedInputs: 0 }, { kind: 'installing' });
    render(<UpdateBanner view={READY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Agent còn 1 tin chờ.');
    await userEvent.click(screen.getByRole('button', { name: 'Huỷ' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fake.api.update.install).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Agent đang chạy 2 lượt.');
    await userEvent.click(screen.getByRole('button', { name: 'Cập nhật ngay' }));
    expect(fake.api.update.install).toHaveBeenLastCalledWith('now');
  });

  it('offers only "now" when an old core cannot tell whether it is busy', async () => {
    answer({ kind: 'busy_unknown' });
    render(<UpdateBanner view={READY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('bản core cũ');
    expect(screen.queryByRole('button', { name: 'Cập nhật khi rảnh' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cập nhật ngay' })).toHaveFocus();
  });

  it('shows why the last install did not happen', () => {
    render(<UpdateBanner view={{ ...READY, installError: 'Bot chưa dừng sau 25 giây nên chưa cài bản mới.' }} />);
    expect(screen.getByText(/Bot chưa dừng sau 25 giây/)).toBeInTheDocument();
  });

  it('reports a failed install call', async () => {
    fake.api.update.install = vi.fn(() => Promise.resolve(fail('timeout', 'Bot chưa dừng sau 25 giây nên chưa cài bản mới.')));
    render(<UpdateBanner view={READY} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cập nhật không thành công');
  });

  it('waits for the agent with a way to install now or stop waiting', async () => {
    render(<UpdateBanner view={{ kind: 'waiting_idle', currentVersion: '0.1.0', version: '0.1.1', activeTurns: 1, queuedInputs: 3 }} />);
    expect(screen.getByText('Sẽ cập nhật lên v0.1.1 khi agent rảnh')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Còn 1 lượt đang chạy, 3 tin chờ.');
    await userEvent.click(screen.getByRole('button', { name: 'Huỷ' }));
    expect(fake.api.update.cancelWaiting).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cập nhật ngay' }));
    expect(fake.api.update.install).toHaveBeenCalledWith('now');
  });

  it('opens the download page on macOS', async () => {
    render(
      <UpdateBanner
        view={{
          kind: 'available',
          currentVersion: '0.1.0',
          version: '0.2.0',
          downloadUrl: 'https://github.com/nguyenkechien/agentpager/releases/tag/v0.2.0',
          checkedAt: '2026-09-15T10:00:00.000Z',
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Tải bản mới' }));
    expect(fake.api.update.openDownload).toHaveBeenCalled();
  });

  it('says the update is installing', () => {
    render(<UpdateBanner view={{ kind: 'installing', currentVersion: '0.1.0', version: '0.1.1' }} />);
    expect(screen.getByText('Đang cài bản mới v0.1.1…')).toBeInTheDocument();
  });
});
