import { useEffect, useState } from 'react';
import type { ConfigView, ReloadOutcome, UserView } from '../../shared/api.js';
import { checkUsername } from '../../shared/usernames.js';
import { api } from '../api.js';
import { Banner, Button, Field, useToast } from '../components.js';
import { formatDateTime } from '../format.js';
import { useAction } from '../hooks.js';

function usersOf(config: ConfigView): UserView[] {
  return config.state === 'missing' ? [] : config.users;
}

export function UsersScreen({ config }: { config: ConfigView }) {
  const toast = useToast();
  const action = useAction();
  const restart = useAction();
  const [users, setUsers] = useState<UserView[]>(() => usersOf(config));
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [reloadProblem, setReloadProblem] = useState<string | null>(null);

  // The file changes under us when a user pairs or the CLI edits it.
  useEffect(() => {
    setUsers(usersOf(config));
  }, [config]);

  const afterChange = (reload: ReloadOutcome, done: string): void => {
    toast.show(done);
    if (reload.kind === 'failed') setReloadProblem(reload.message);
    else if (reload.kind === 'reloaded') {
      setReloadProblem(null);
      toast.show('Đã cập nhật danh sách cho bot đang chạy.');
    }
  };

  const add = async (): Promise<void> => {
    const checked = checkUsername(input);
    if (!checked.ok) {
      setInputError(checked.message);
      return;
    }
    setInputError(null);
    const change = await action.run('add', () => api().users.add(checked.username));
    if (change === null) return;
    setUsers(change.users);
    setInput('');
    afterChange(change.reload, `Đã thêm @${checked.username} — nhắn bot một tin từ tài khoản này để ghép.`);
  };

  const remove = async (username: string): Promise<void> => {
    setConfirmRemove(null);
    const change = await action.run(`remove:${username}`, () => api().users.remove(username));
    if (change === null) return;
    setUsers(change.users);
    afterChange(change.reload, `Đã xoá @${username}.`);
  };

  const unpair = async (username: string): Promise<void> => {
    const change = await action.run(`unpair:${username}`, () => api().users.unpair(username));
    if (change === null) return;
    setUsers(change.users);
    afterChange(change.reload, `Đã bỏ ghép @${username} — tin nhắn tiếp theo từ tài khoản này sẽ ghép lại.`);
  };

  const busy = action.pending !== null;
  return (
    <section className="screen" aria-labelledby="users-title">
      <header className="screen-header">
        <h1 id="users-title">Người dùng</h1>
      </header>

      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Field label="Thêm username" htmlFor="users-add" errors={inputError ? [inputError] : undefined} hint="Tin nhắn riêng đầu tiên từ username này sẽ ghép tài khoản.">
          <div className="input-row">
            <input
              id="users-add"
              value={input}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setInput(event.target.value);
              }}
            />
            <Button type="submit" variant="primary" disabled={input.trim() === '' || busy} busy={action.pending === 'add'} busyLabel="Đang thêm…">
              Thêm
            </Button>
          </div>
        </Field>
      </form>

      {action.error ? <Banner tone="error">{action.error.message}</Banner> : null}
      {reloadProblem ? (
        <Banner
          tone="warn"
          title="Không báo được cho bot đang chạy"
          actions={
            <Button
              busy={restart.pending !== null}
              busyLabel="Đang khởi động lại…"
              onClick={() => {
                void restart.run('restart', () => api().daemon.restart()).then((view) => {
                  if (view !== null) setReloadProblem(null);
                });
              }}
            >
              Restart
            </Button>
          }
        >
          {reloadProblem} — Restart để bot dùng danh sách mới.
        </Banner>
      ) : null}
      {restart.error ? <Banner tone="error">{restart.error.message}</Banner> : null}

      {users.length === 0 ? (
        <p className="muted">Chưa có người dùng.</p>
      ) : (
        <ul className="user-list">
          {users.map((user) => (
            <li key={user.username} className="user-row">
              <div>
                <strong>@{user.username}</strong>
                <span className={user.paired ? 'success-text' : 'muted'}>
                  {user.paired ? `đã ghép${user.pairedAt ? ` (${formatDateTime(user.pairedAt)})` : ''}` : 'chờ ghép'}
                </span>
              </div>
              {confirmRemove === user.username ? (
                <div className="button-row" role="group" aria-label={`Xác nhận xoá @${user.username}`}>
                  <span>Xoá @{user.username}?</span>
                  <Button
                    variant="danger"
                    onClick={() => {
                      void remove(user.username);
                    }}
                  >
                    Xoá
                  </Button>
                  <Button
                    onClick={() => {
                      setConfirmRemove(null);
                    }}
                  >
                    Huỷ
                  </Button>
                </div>
              ) : (
                <div className="button-row">
                  {user.paired ? (
                    <Button
                      disabled={busy}
                      busy={action.pending === `unpair:${user.username}`}
                      busyLabel="Đang bỏ ghép…"
                      onClick={() => {
                        void unpair(user.username);
                      }}
                    >
                      Bỏ ghép
                    </Button>
                  ) : null}
                  <Button
                    variant="danger"
                    disabled={busy}
                    aria-label={`Xoá @${user.username}`}
                    onClick={() => {
                      setConfirmRemove(user.username);
                    }}
                  >
                    Xoá
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
