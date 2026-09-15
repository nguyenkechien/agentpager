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
      toast.show('Updated the list for the running bot.');
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
    afterChange(change.reload, `Added @${checked.username} — send the bot a message from this account to pair it.`);
  };

  const remove = async (username: string): Promise<void> => {
    setConfirmRemove(null);
    const change = await action.run(`remove:${username}`, () => api().users.remove(username));
    if (change === null) return;
    setUsers(change.users);
    afterChange(change.reload, `Removed @${username}.`);
  };

  const unpair = async (username: string): Promise<void> => {
    const change = await action.run(`unpair:${username}`, () => api().users.unpair(username));
    if (change === null) return;
    setUsers(change.users);
    afterChange(change.reload, `Unpaired @${username} — the next message from this account pairs it again.`);
  };

  const busy = action.pending !== null;
  return (
    <section className="screen" aria-labelledby="users-title">
      <header className="screen-header">
        <h1 id="users-title">Users</h1>
      </header>

      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Field label="Add username" htmlFor="users-add" errors={inputError ? [inputError] : undefined} hint="The first private message from this username pairs the account.">
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
            <Button type="submit" variant="primary" disabled={input.trim() === '' || busy} busy={action.pending === 'add'} busyLabel="Adding…">
              Add
            </Button>
          </div>
        </Field>
      </form>

      {action.error ? <Banner tone="error">{action.error.message}</Banner> : null}
      {reloadProblem ? (
        <Banner
          tone="warn"
          title="Could not notify the running bot"
          actions={
            <Button
              busy={restart.pending !== null}
              busyLabel="Restarting…"
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
          {reloadProblem} — Restart so the bot uses the new list.
        </Banner>
      ) : null}
      {restart.error ? <Banner tone="error">{restart.error.message}</Banner> : null}

      {users.length === 0 ? (
        <p className="muted">No users yet.</p>
      ) : (
        <ul className="user-list">
          {users.map((user) => (
            <li key={user.username} className="user-row">
              <div>
                <strong>@{user.username}</strong>
                <span className={user.paired ? 'success-text' : 'muted'}>
                  {user.paired ? `paired${user.pairedAt ? ` (${formatDateTime(user.pairedAt)})` : ''}` : 'waiting to pair'}
                </span>
              </div>
              {confirmRemove === user.username ? (
                <div className="button-row" role="group" aria-label={`Confirm removing @${user.username}`}>
                  <span>Remove @{user.username}?</span>
                  <Button
                    variant="danger"
                    onClick={() => {
                      void remove(user.username);
                    }}
                  >
                    Remove
                  </Button>
                  <Button
                    onClick={() => {
                      setConfirmRemove(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="button-row">
                  {user.paired ? (
                    <Button
                      disabled={busy}
                      busy={action.pending === `unpair:${user.username}`}
                      busyLabel="Unpairing…"
                      onClick={() => {
                        void unpair(user.username);
                      }}
                    >
                      Unpair
                    </Button>
                  ) : null}
                  <Button
                    variant="danger"
                    disabled={busy}
                    aria-label={`Remove @${user.username}`}
                    onClick={() => {
                      setConfirmRemove(user.username);
                    }}
                  >
                    Remove
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
