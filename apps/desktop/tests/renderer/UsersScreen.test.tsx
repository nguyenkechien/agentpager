import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../src/renderer/components.js';
import { UsersScreen } from '../../src/renderer/screens/UsersScreen.js';
import type { ConfigView } from '../../src/shared/api.js';
import { fail, installFakeApi, ok, user, validConfig, type FakeApi } from './fakeApi.js';

let fake: FakeApi;

beforeEach(() => {
  fake = installFakeApi();
});

function renderUsers(config: ConfigView = validConfig()) {
  return render(
    <ToastProvider>
      <UsersScreen config={config} />
    </ToastProvider>,
  );
}

function row(username: string): HTMLElement {
  const item = screen.getByText(`@${username}`).closest('li');
  if (!item) throw new Error(`no row for @${username}`);
  return item;
}

describe('UsersScreen', () => {
  it('lists users as paired with the date or waiting', () => {
    renderUsers();
    expect(within(row('alice_one')).getByText(/^đã ghép \(14\/09\/2026 \d\d:00\)$/)).toBeInTheDocument();
    expect(within(row('bob_two')).getByText('chờ ghép')).toBeInTheDocument();
    expect(within(row('bob_two')).queryByRole('button', { name: 'Bỏ ghép' })).not.toBeInTheDocument();
  });

  it('adds a normalised username and reports a bot that was told', async () => {
    fake.api.users.add = vi.fn(() =>
      Promise.resolve(ok({ users: [user('alice_one', '2026-09-14T09:00:00.000Z'), user('bob_two'), user('carol_three')], reload: { kind: 'reloaded' as const } })),
    );
    renderUsers();
    await userEvent.type(screen.getByLabelText('Thêm username'), '@Carol_Three{Enter}');
    expect(fake.api.users.add).toHaveBeenCalledWith('carol_three');
    expect(await screen.findByText('@carol_three')).toBeInTheDocument();
    expect(screen.getByText('Đã cập nhật danh sách cho bot đang chạy.')).toBeInTheDocument();
    expect(screen.getByLabelText('Thêm username')).toHaveValue('');
  });

  it('rejects an invalid username without calling the app', async () => {
    renderUsers();
    await userEvent.type(screen.getByLabelText('Thêm username'), '@x{Enter}');
    expect(screen.getByText('Username không hợp lệ: "@x" (5–32 ký tự a-z, 0-9, _)')).toBeInTheDocument();
    expect(fake.api.users.add).not.toHaveBeenCalled();
  });

  it('asks before removing and shows the refusal for the last user', async () => {
    fake.api.users.remove = vi.fn(() => Promise.resolve(fail('invalid_input', 'Không thể xoá người dùng cuối cùng — bot cần ít nhất 1 người dùng.')));
    renderUsers(validConfig({ users: [user('alice_one')] }));
    await userEvent.click(screen.getByRole('button', { name: 'Xoá @alice_one' }));
    const confirm = screen.getByRole('group', { name: 'Xác nhận xoá @alice_one' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Huỷ' }));
    expect(fake.api.users.remove).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Xoá @alice_one' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Xác nhận xoá @alice_one' })).getByRole('button', { name: 'Xoá' }));
    expect(fake.api.users.remove).toHaveBeenCalledWith('alice_one');
    expect(await screen.findByText('Không thể xoá người dùng cuối cùng — bot cần ít nhất 1 người dùng.')).toBeInTheDocument();
  });

  it('unpairs a user and offers a restart when the running bot could not be told', async () => {
    fake.api.users.unpair = vi.fn(() =>
      Promise.resolve(ok({ users: [user('alice_one'), user('bob_two')], reload: { kind: 'failed' as const, message: 'Daemon không phản hồi sau 5000 ms' } })),
    );
    renderUsers();
    await userEvent.click(within(row('alice_one')).getByRole('button', { name: 'Bỏ ghép' }));
    expect(fake.api.users.unpair).toHaveBeenCalledWith('alice_one');
    expect(await screen.findByText('Daemon không phản hồi sau 5000 ms — Restart để bot dùng danh sách mới.')).toBeInTheDocument();
    expect(within(row('alice_one')).getByText('chờ ghép')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(fake.api.daemon.restart).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Restart để bot dùng danh sách mới/)).not.toBeInTheDocument();
  });

  it('follows pairing written to the config file', () => {
    const { rerender } = renderUsers(validConfig({ users: [user('bob_two')] }));
    expect(within(row('bob_two')).getByText('chờ ghép')).toBeInTheDocument();
    rerender(
      <ToastProvider>
        <UsersScreen config={validConfig({ users: [user('bob_two', '2026-09-14T11:30:00.000Z')] })} />
      </ToastProvider>,
    );
    expect(within(row('bob_two')).getByText(/^đã ghép/)).toBeInTheDocument();
  });
});
