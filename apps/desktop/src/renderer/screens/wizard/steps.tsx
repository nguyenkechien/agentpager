import { useEffect, useState } from 'react';
import type { UserView } from '../../../shared/api.js';
import { homeOverrideNote } from '../../../shared/labels.js';
import { checkUsername } from '../../../shared/usernames.js';
import { api } from '../../api.js';
import { Banner, Button, Field, Toggle } from '../../components.js';
import { useConfig } from '../../hooks.js';
import { parseIdleMinutes, type StepProps, type TokenState } from './model.js';

export function TokenStep({
  data,
  update,
  errors,
  setTokenState,
}: StepProps & { setTokenState: (token: string, state: TokenState) => void }) {
  const state = data.tokenState;
  const check = async (): Promise<void> => {
    const token = data.token;
    setTokenState(token, { kind: 'checking' });
    const result = await api().config.verifyToken(token);
    if (result.ok) setTokenState(token, { kind: 'valid', username: result.data.username });
    else if (result.error.code === 'network') setTokenState(token, { kind: 'network', message: result.error.message, confirmed: false });
    else setTokenState(token, { kind: 'invalid', message: result.error.message });
  };
  return (
    <div className="step">
      <h2>Bot token</h2>
      <p>
        Create a bot with <strong>@BotFather</strong> on Telegram (the <code>/newbot</code> command), then paste its token here.
      </p>
      <Field label="Token" htmlFor="wizard-token" errors={errors}>
        <input
          id="wizard-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={data.token}
          onChange={(event) => {
            update({ token: event.target.value, tokenState: { kind: 'unchecked' } });
          }}
        />
      </Field>
      <Button
        disabled={data.token.trim() === ''}
        busy={state.kind === 'checking'}
        busyLabel="Checking…"
        onClick={() => {
          void check();
        }}
      >
        Check
      </Button>
      {state.kind === 'valid' ? (
        <p className="success-text" role="status">
          ✅ @{state.username}
        </p>
      ) : null}
      {state.kind === 'invalid' ? <Banner tone="error">{state.message}</Banner> : null}
      {state.kind === 'network' ? (
        <Banner
          tone="warn"
          actions={
            state.confirmed ? undefined : (
              <Button
                onClick={() => {
                  update({ tokenState: { ...state, confirmed: true } });
                }}
              >
                Continue anyway
              </Button>
            )
          }
        >
          {state.message}
          {state.confirmed ? ' — the bot will check the token when it starts.' : ' You can continue and let the bot check the token when it starts.'}
        </Banner>
      ) : null}
    </div>
  );
}

export function UsersStep({ data, update, errors }: StepProps) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = (): void => {
    const parts = input.split(/[\s,]+/).filter((part) => part !== '');
    if (parts.length === 0) return;
    const next = [...data.usernames];
    for (const part of parts) {
      const checked = checkUsername(part);
      if (!checked.ok) {
        setError(checked.message);
        return;
      }
      if (!next.includes(checked.username)) next.push(checked.username);
    }
    update({ usernames: next });
    setInput('');
    setError(null);
  };
  const shownErrors = [...(error ? [error] : []), ...(errors ?? [])];
  return (
    <div className="step">
      <h2>Users</h2>
      <p>Only these Telegram usernames can use the bot. The first message from each username pairs that account.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Field label="Username" htmlFor="wizard-username" errors={shownErrors} hint="For example: @alice, @bob — press Enter to add.">
          <div className="input-row">
            <input
              id="wizard-username"
              value={input}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setInput(event.target.value);
              }}
            />
            <Button type="submit" disabled={input.trim() === ''}>
              Add
            </Button>
          </div>
        </Field>
      </form>
      <ul className="chips" aria-label="Added usernames">
        {data.usernames.map((username) => (
          <li key={username} className="chip">
            @{username}
            <button
              type="button"
              aria-label={`Remove @${username}`}
              onClick={() => {
                update({ usernames: data.usernames.filter((entry) => entry !== username) });
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProjectsStep({ data, update, errors }: StepProps) {
  const [pickError, setPickError] = useState<string | null>(null);
  const pick = async (): Promise<void> => {
    const result = await api().dialog.pickFolder(data.projectsRoot.trim() === '' ? null : data.projectsRoot);
    if (!result.ok) setPickError(result.error.message);
    else if (result.data !== null) update({ projectsRoot: result.data });
  };
  return (
    <div className="step">
      <h2>Projects folder</h2>
      <p>The folder that holds your projects. In Telegram, the /project command picks a working folder inside it.</p>
      <Field label="Projects folder" htmlFor="wizard-projects" errors={[...(pickError ? [pickError] : []), ...(errors ?? [])]}>
        <div className="input-row">
          <input
            id="wizard-projects"
            value={data.projectsRoot}
            spellCheck={false}
            onChange={(event) => {
              update({ projectsRoot: event.target.value });
            }}
          />
          <Button
            onClick={() => {
              void pick();
            }}
          >
            Choose…
          </Button>
        </div>
      </Field>
    </div>
  );
}

export function AgentStep({ data, update, errors }: StepProps) {
  const [error, setError] = useState<string | null>(null);
  const provider = data.providers.find((entry) => entry.id === data.provider) ?? null;
  const { executable } = data;
  const providerId = data.provider;

  useEffect(() => {
    if (providerId === null) return;
    let active = true;
    update({ detection: null });
    void api()
      .agent.detect(providerId, executable)
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          update({ detection: result.data });
          setError(null);
        } else {
          setError(result.error.message);
        }
      });
    return () => {
      active = false;
    };
  }, [providerId, executable, update]);

  const pick = async (): Promise<void> => {
    const result = await api().dialog.pickExecutable(executable ?? data.detection?.executable ?? null);
    if (!result.ok) setError(result.error.message);
    else if (result.data !== null) update({ executable: result.data });
  };

  const name = provider?.displayName ?? 'Agent';
  const detection = data.detection;
  return (
    <div className="step">
      <h2>Agent</h2>
      <p>
        Agent: <strong>{name}</strong>
      </p>
      {detection === null ? <p role="status">Looking for {name} CLI…</p> : null}
      {detection?.executable === null ? (
        <Banner tone="warn">{name} CLI was not found on this machine — the agent will use the one bundled with the SDK. Choose the file if it is installed elsewhere.</Banner>
      ) : null}
      {detection?.executable ? (
        <p role="status">
          🔎 {detection.executable}
          {detection.version ? ` (${detection.version})` : ''}
        </p>
      ) : null}
      {detection?.problems.map((problem) => (
        <p key={problem} className="warning-text">
          ⚠️ {problem}
        </p>
      ))}
      {[...(error ? [error] : []), ...(errors ?? [])].map((message) => (
        <p key={message} className="error-text" role="alert">
          {message}
        </p>
      ))}
      <div className="button-row">
        <Button
          onClick={() => {
            void pick();
          }}
        >
          Choose file…
        </Button>
        {executable !== null ? (
          <Button
            onClick={() => {
              update({ executable: null });
            }}
          >
            Use auto-detected
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function IdleStep({ data, update, errors }: StepProps) {
  const invalid = parseIdleMinutes(data.idleMinutes) === null;
  return (
    <div className="step">
      <h2>Session idle timeout</h2>
      <p>A session with the agent ends by itself after this many minutes without a message.</p>
      <Field label="Minutes" htmlFor="wizard-idle" errors={[...(invalid ? ['Must be a whole number ≥ 1.'] : []), ...(errors ?? [])]}>
        <input
          id="wizard-idle"
          type="number"
          min={1}
          step={1}
          value={data.idleMinutes}
          onChange={(event) => {
            update({ idleMinutes: event.target.value });
          }}
        />
      </Field>
    </div>
  );
}

export function FinishStep({
  data,
  update,
  saving,
  saved,
  saveError,
  startError,
  formErrors,
  homeOverride,
  onSave,
}: StepProps & {
  saving: boolean;
  saved: boolean;
  saveError: string | null;
  startError: string | null;
  formErrors: readonly string[] | undefined;
  homeOverride: string | null;
  onSave: () => void;
}) {
  const executable = data.executable ?? data.detection?.executable ?? null;
  const tokenText =
    data.tokenState.kind === 'valid' ? `@${data.tokenState.username}` : 'not checked (could not connect to Telegram)';
  return (
    <div className="step">
      <h2>Finish</h2>
      <dl className="details">
        <dt>Bot</dt>
        <dd>{tokenText}</dd>
        <dt>Users</dt>
        <dd>{data.usernames.map((username) => `@${username}`).join(', ')}</dd>
        <dt>Projects folder</dt>
        <dd>{data.projectsRoot}</dd>
        <dt>Agent CLI</dt>
        <dd>{executable ?? 'bundled with the SDK'}</dd>
        <dt>Session idle timeout</dt>
        <dd>
          {data.idleMinutes} {Number(data.idleMinutes) === 1 ? 'minute' : 'minutes'}
        </dd>
      </dl>
      {homeOverride !== null ? (
        <p className="muted">{homeOverrideNote(homeOverride)}</p>
      ) : (
      <div className="stack">
        <Toggle
          label="Start the bot at login"
          checked={data.autostart}
          disabled={saving || saved}
          onChange={(autostart) => {
            update({ autostart });
          }}
        />
        <Toggle
          label="Show tray icon at login"
          checked={data.trayAtLogin}
          disabled={saving || saved}
          onChange={(trayAtLogin) => {
            update({ trayAtLogin });
          }}
        />
      </div>
      )}
      {formErrors && formErrors.length > 0 ? (
        <Banner tone="error" title="The config is not valid">
          <ul>
            {formErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {saveError ? <Banner tone="error">{saveError}</Banner> : null}
      {startError ? (
        <Banner tone="error" title="Settings saved, but the bot could not start">
          {startError}
        </Banner>
      ) : null}
      <Button variant="primary" busy={saving} busyLabel="Saving and starting…" onClick={onSave}>
        {saved ? 'Try starting again' : 'Save & start bot'}
      </Button>
    </div>
  );
}

function pairingText(user: UserView): string {
  return user.paired ? '✅ paired' : 'waiting for a message…';
}

export function PairingStep({ botUsername, warnings, onDone }: { botUsername: string | null; warnings: string[]; onDone: () => void }) {
  const config = useConfig();
  const users = config.view === null || config.view.state === 'missing' ? [] : config.view.users;
  return (
    <div className="step">
      <h2>Pair accounts</h2>
      {warnings.length > 0 ? (
        <Banner tone="warn" title="The bot is running, but:">
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <p>
        Send any message to <strong>@{botUsername ?? 'bot'}</strong> from each account below. Paired accounts show ✅.
      </p>
      <ul className="pairing-list">
        {users.map((user) => (
          <li key={user.username}>
            <span>@{user.username}</span> <span className={user.paired ? 'success-text' : 'muted'}>{pairingText(user)}</span>
          </li>
        ))}
      </ul>
      <Button variant="primary" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
