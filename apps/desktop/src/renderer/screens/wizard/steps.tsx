import { useEffect, useState } from 'react';
import type { UserView } from '../../../shared/api.js';
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
        Tạo bot với <strong>@BotFather</strong> trên Telegram (lệnh <code>/newbot</code>) rồi dán token vào đây.
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
        busyLabel="Đang kiểm tra…"
        onClick={() => {
          void check();
        }}
      >
        Kiểm tra
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
                Vẫn tiếp tục
              </Button>
            )
          }
        >
          {state.message}
          {state.confirmed ? ' — bot sẽ kiểm tra token khi chạy.' : ' Có thể tiếp tục và để bot kiểm tra token khi chạy.'}
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
      <h2>Người dùng</h2>
      <p>Chỉ các username Telegram này được dùng bot. Tin nhắn đầu tiên từ mỗi username sẽ ghép tài khoản đó.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Field label="Username" htmlFor="wizard-username" errors={shownErrors} hint="Ví dụ: @alice, @bob — Enter để thêm.">
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
              Thêm
            </Button>
          </div>
        </Field>
      </form>
      <ul className="chips" aria-label="Username đã thêm">
        {data.usernames.map((username) => (
          <li key={username} className="chip">
            @{username}
            <button
              type="button"
              aria-label={`Bỏ @${username}`}
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
      <h2>Thư mục project</h2>
      <p>Thư mục chứa các project. Trong Telegram, lệnh /project chọn thư mục làm việc bên trong nó.</p>
      <Field label="Thư mục chứa các project" htmlFor="wizard-projects" errors={[...(pickError ? [pickError] : []), ...(errors ?? [])]}>
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
            Chọn…
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
      {detection === null ? <p role="status">Đang dò {name} CLI…</p> : null}
      {detection?.executable === null ? (
        <Banner tone="warn">Không tìm thấy {name} CLI trên máy — agent sẽ dùng bản đi kèm SDK. Chọn file nếu đã cài ở chỗ khác.</Banner>
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
          Chọn file…
        </Button>
        {executable !== null ? (
          <Button
            onClick={() => {
              update({ executable: null });
            }}
          >
            Dùng bản tự dò
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
      <h2>Thời gian chờ phiên</h2>
      <p>Phiên làm việc với agent tự kết thúc sau chừng này phút không có tin nhắn.</p>
      <Field label="Số phút" htmlFor="wizard-idle" errors={[...(invalid ? ['Cần số nguyên ≥ 1.'] : []), ...(errors ?? [])]}>
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
  onSave,
}: StepProps & {
  saving: boolean;
  saved: boolean;
  saveError: string | null;
  startError: string | null;
  formErrors: readonly string[] | undefined;
  onSave: () => void;
}) {
  const executable = data.executable ?? data.detection?.executable ?? null;
  const tokenText =
    data.tokenState.kind === 'valid' ? `@${data.tokenState.username}` : 'chưa kiểm tra được (không kết nối Telegram)';
  return (
    <div className="step">
      <h2>Hoàn tất</h2>
      <dl className="details">
        <dt>Bot</dt>
        <dd>{tokenText}</dd>
        <dt>Người dùng</dt>
        <dd>{data.usernames.map((username) => `@${username}`).join(', ')}</dd>
        <dt>Thư mục project</dt>
        <dd>{data.projectsRoot}</dd>
        <dt>Agent CLI</dt>
        <dd>{executable ?? 'bản đi kèm SDK'}</dd>
        <dt>Thời gian chờ phiên</dt>
        <dd>{data.idleMinutes} phút</dd>
      </dl>
      <div className="stack">
        <Toggle
          label="Tự khởi động bot khi đăng nhập"
          checked={data.autostart}
          disabled={saving || saved}
          onChange={(autostart) => {
            update({ autostart });
          }}
        />
        <Toggle
          label="Hiện icon khay khi đăng nhập"
          checked={data.trayAtLogin}
          disabled={saving || saved}
          onChange={(trayAtLogin) => {
            update({ trayAtLogin });
          }}
        />
      </div>
      {formErrors && formErrors.length > 0 ? (
        <Banner tone="error" title="Cấu hình chưa hợp lệ">
          <ul>
            {formErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {saveError ? <Banner tone="error">{saveError}</Banner> : null}
      {startError ? (
        <Banner tone="error" title="Đã lưu cấu hình nhưng bot chưa chạy được">
          {startError}
        </Banner>
      ) : null}
      <Button variant="primary" busy={saving} busyLabel="Đang lưu và khởi động…" onClick={onSave}>
        {saved ? 'Thử chạy lại' : 'Lưu & chạy bot'}
      </Button>
    </div>
  );
}

function pairingText(user: UserView): string {
  return user.paired ? '✅ đã ghép' : 'đang chờ tin nhắn…';
}

export function PairingStep({ botUsername, warnings, onDone }: { botUsername: string | null; warnings: string[]; onDone: () => void }) {
  const config = useConfig();
  const users = config.view === null || config.view.state === 'missing' ? [] : config.view.users;
  return (
    <div className="step">
      <h2>Ghép tài khoản</h2>
      {warnings.length > 0 ? (
        <Banner tone="warn" title="Bot đã chạy, nhưng:">
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <p>
        Nhắn một tin bất kỳ cho <strong>@{botUsername ?? 'bot'}</strong> từ từng tài khoản dưới đây. Tài khoản nào đã ghép sẽ hiện ✅.
      </p>
      <ul className="pairing-list">
        {users.map((user) => (
          <li key={user.username}>
            <span>@{user.username}</span> <span className={user.paired ? 'success-text' : 'muted'}>{pairingText(user)}</span>
          </li>
        ))}
      </ul>
      <Button variant="primary" onClick={onDone}>
        Xong
      </Button>
    </div>
  );
}
