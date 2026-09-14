import { useCallback, useEffect, useState } from 'react';
import type { AgentDetectionView, AutostartView, ConfigView, DaemonView } from '../../shared/api.js';
import { api, errorOf, unwrap } from '../api.js';
import { Badge, Banner, Button, Toggle, useToast } from '../components.js';
import { formatDuration } from '../format.js';
import { useAction } from '../hooks.js';
import type { ScreenId } from '../screens.js';

const BUSY_LABELS: Record<string, string> = {
  start: 'Đang khởi động…',
  stop: 'Đang dừng…',
  restart: 'Đang khởi động lại…',
};

/** The core's fatal message for a rejected token, e.g. "Token Telegram không hợp lệ (401 Unauthorized)". */
function isTokenProblem(message: string | null | undefined): boolean {
  return message !== null && message !== undefined && /token/i.test(message);
}

function launcherText(view: DaemonView): string {
  if (view.launcher === null) return '—';
  return view.launcher.kind === 'app' ? 'chạy từ app' : 'chạy từ npm CLI';
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

export function StatusScreen({
  daemon,
  config,
  onNavigate,
}: {
  daemon: DaemonView | null;
  config: ConfigView;
  onNavigate: (screen: ScreenId) => void;
}) {
  const toast = useToast();
  const action = useAction();
  const now = useNow(1_000);
  const [autostart, setAutostart] = useState<AutostartView | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [detection, setDetection] = useState<AgentDetectionView | null>(null);

  const agent = config.state === 'valid' ? config.settings.agent : null;
  const provider = agent?.provider ?? null;
  const executable = agent?.executable ?? null;

  useEffect(() => {
    let active = true;
    unwrap(api().autostart.get()).then(
      (view) => {
        if (active) setAutostart(view);
      },
      (reason: unknown) => {
        if (active) setAutostartError(errorOf(reason).message);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (provider === null) return;
    let active = true;
    unwrap(api().agent.detect(provider, executable)).then(
      (view) => {
        if (active) setDetection(view);
      },
      (reason: unknown) => {
        if (active) setDetection({ executable, version: null, problems: [errorOf(reason).message] });
      },
    );
    return () => {
      active = false;
    };
  }, [provider, executable]);

  const setAutostartEnabled = useCallback(
    async (enabled: boolean) => {
      const previous = autostart;
      // Show the new position at once; a failure puts it back.
      if (previous) setAutostart({ ...previous, enabled });
      setAutostartBusy(true);
      const result = await api().autostart.set(enabled);
      setAutostartBusy(false);
      if (result.ok) {
        setAutostart(result.data);
        setAutostartError(null);
      } else {
        setAutostart(previous);
        toast.show(`Không đổi được tự khởi động: ${result.error.message}`, 'error');
      }
    },
    [autostart, toast],
  );

  const badge = daemon?.badge ?? null;
  const nothingRuns = badge === 'stopped' || badge === 'error';
  const busy = action.pending !== null;
  const lastError = action.error?.message ?? daemon?.lastError ?? null;

  return (
    <section className="screen" aria-labelledby="status-title">
      <header className="screen-header">
        <h1 id="status-title">Trạng thái</h1>
        <Badge state={badge} large />
      </header>

      <div className="button-row">
        <Button
          variant="primary"
          disabled={!nothingRuns || busy}
          busy={action.pending === 'start'}
          busyLabel={BUSY_LABELS.start}
          onClick={() => {
            void action.run('start', () => api().daemon.start());
          }}
        >
          Start
        </Button>
        <Button
          disabled={nothingRuns || badge === null || busy}
          busy={action.pending === 'stop'}
          busyLabel={BUSY_LABELS.stop}
          onClick={() => {
            void action.run('stop', () => api().daemon.stop());
          }}
        >
          Stop
        </Button>
        <Button
          disabled={nothingRuns || badge === null || busy}
          busy={action.pending === 'restart'}
          busyLabel={BUSY_LABELS.restart}
          onClick={() => {
            void action.run('restart', () => api().daemon.restart());
          }}
        >
          Restart
        </Button>
      </div>

      {action.error ? (
        <Banner
          tone="error"
          title="Không thành công"
          actions={
            isTokenProblem(action.error.message) ? (
              <Button
                onClick={() => {
                  onNavigate('settings');
                }}
              >
                Đổi token
              </Button>
            ) : (
              <Button
                onClick={() => {
                  void api().shell.openLogFolder();
                }}
              >
                Mở thư mục log
              </Button>
            )
          }
        >
          {action.error.message}
        </Banner>
      ) : null}

      {badge === 'unresponsive' ? (
        <Banner
          tone="warn"
          title="Bot không phản hồi"
          actions={
            <Button
              onClick={() => {
                void api().shell.openLogFolder();
              }}
            >
              Mở thư mục log
            </Button>
          }
        >
          Daemon vẫn đang chạy nhưng không trả lời. Xem log để biết nó đang làm gì.
        </Banner>
      ) : null}

      {badge === 'disconnected' ? (
        <Banner tone="warn" title="Mất kết nối với bot">
          Thông tin kết nối của daemon đã cũ (thường do daemon được chạy lại từ nơi khác). Bấm Restart để kết nối lại.
        </Banner>
      ) : null}

      {badge === 'error' && !action.error && isTokenProblem(daemon?.lastError) ? (
        <Banner
          tone="error"
          title="Bot dừng vì token"
          actions={
            <Button
              onClick={() => {
                onNavigate('settings');
              }}
            >
              Đổi token
            </Button>
          }
        >
          {daemon?.lastError}
        </Banner>
      ) : null}

      <dl className="details">
        <dt>Bot</dt>
        <dd>{daemon?.botUsername ? `@${daemon.botUsername}` : '—'}</dd>
        <dt>PID daemon</dt>
        <dd>{daemon?.pid ?? '—'}</dd>
        <dt>Thời gian chạy</dt>
        <dd>{daemon?.startedAt ? formatDuration(now - new Date(daemon.startedAt).getTime()) : '—'}</dd>
        <dt>Khởi động lại</dt>
        <dd>{daemon ? `${String(daemon.restarts)} lần` : '—'}</dd>
        <dt>Lỗi gần nhất</dt>
        <dd>{lastError ?? '—'}</dd>
        <dt>Agent CLI</dt>
        <dd>
          {detection === null
            ? '—'
            : detection.executable === null
              ? 'bản đi kèm SDK'
              : `${detection.executable}${detection.version ? ` (${detection.version})` : ''}`}
          {detection?.problems.map((problem) => (
            <div key={problem} className="warning-text">
              ⚠️ {problem}
            </div>
          ))}
        </dd>
        <dt>Nguồn chạy</dt>
        <dd>{daemon ? launcherText(daemon) : '—'}</dd>
      </dl>

      <section className="card" aria-labelledby="autostart-title">
        <h2 id="autostart-title">Tự khởi động</h2>
        <Toggle
          label="Tự khởi động bot khi đăng nhập"
          checked={autostart?.enabled ?? false}
          disabled={autostart === null || autostartBusy}
          onChange={(enabled) => {
            void setAutostartEnabled(enabled);
          }}
        />
        {autostartError ? <p className="warning-text">⚠️ {autostartError}</p> : null}
        {autostart && autostart.problems.length > 0 ? (
          <Banner
            tone="warn"
            title="Tự khởi động cần sửa"
            actions={
              <Button
                disabled={autostartBusy}
                onClick={() => {
                  void setAutostartEnabled(true);
                }}
              >
                Sửa tự khởi động
              </Button>
            }
          >
            <ul>
              {autostart.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {autostart?.enabled && !autostart.ownedByThisApp && autostart.problems.length === 0 ? (
          <Banner
            tone="info"
            title="Tự khởi động đang dùng bản agentpager khác"
            actions={
              <Button
                disabled={autostartBusy}
                onClick={() => {
                  void setAutostartEnabled(true);
                }}
              >
                Chuyển tự khởi động sang app này
              </Button>
            }
          >
            {autostart.command ? <code>{autostart.command.join(' ')}</code> : null}
          </Banner>
        ) : null}
      </section>
    </section>
  );
}
