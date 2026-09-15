import { useCallback, useEffect, useState } from 'react';
import type { AgentDetectionView, AutostartView, ConfigView, DaemonView } from '../../shared/api.js';
import { api, errorOf, unwrap } from '../api.js';
import { Badge, Banner, Button, Toggle, useToast } from '../components.js';
import { formatDuration, plural } from '../format.js';
import { homeOverrideNote } from '../../shared/labels.js';
import { useAction, useAppInfo } from '../hooks.js';
import type { ScreenId } from '../screens.js';

const BUSY_LABELS: Record<string, string> = {
  start: 'Starting…',
  stop: 'Stopping…',
  restart: 'Restarting…',
  switch: 'Switching…',
};

/** The core's fatal message for a token the Bot API rejects (401 Unauthorized) mentions the token. */
function isTokenProblem(message: string | null | undefined): boolean {
  return message !== null && message !== undefined && /token/i.test(message);
}

function launcherText(view: DaemonView): string {
  if (view.launcher !== null) return view.launcher.kind === 'app' ? 'agentpager app' : 'agentpager cli';
  // Only agentpager 0.1.x daemons leave the launcher out of daemon.json, and those came from the cli.
  return view.pid === null ? '—' : 'agentpager cli (0.1.x)';
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
  const appInfo = useAppInfo();
  const [autostart, setAutostart] = useState<AutostartView | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [detection, setDetection] = useState<AgentDetectionView | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);

  const agent = config.state === 'valid' ? config.settings.agent : null;
  const provider = agent?.provider ?? null;
  const executable = agent?.executable ?? null;

  useEffect(() => {
    if (appInfo === null || appInfo.homeOverride !== null) return;
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
  }, [appInfo]);

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
        toast.show(`Could not change autostart: ${result.error.message}`, 'error');
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
        <h1 id="status-title">Status</h1>
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
          title="Action failed"
          actions={
            isTokenProblem(action.error.message) ? (
              <Button
                onClick={() => {
                  onNavigate('settings');
                }}
              >
                Change token
              </Button>
            ) : (
              <Button
                onClick={() => {
                  void api().shell.openLogFolder();
                }}
              >
                Open log folder
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
          title="Bot not responding"
          actions={
            <Button
              onClick={() => {
                void api().shell.openLogFolder();
              }}
            >
              Open log folder
            </Button>
          }
        >
          The daemon is still running but not answering. Check the log to see what it is doing.
        </Banner>
      ) : null}

      {badge === 'disconnected' ? (
        <Banner tone="warn" title="Lost connection to the bot">
          The daemon connection details are out of date (usually because the daemon was restarted from somewhere else). Click Restart to reconnect.
        </Banner>
      ) : null}

      {badge === 'error' && !action.error && isTokenProblem(daemon?.lastError) ? (
        <Banner
          tone="error"
          title="The bot stopped because of its token"
          actions={
            <Button
              onClick={() => {
                onNavigate('settings');
              }}
            >
              Change token
            </Button>
          }
        >
          {daemon?.lastError}
        </Banner>
      ) : null}

      {badge === 'running' && daemon?.launcher?.kind !== 'app' ? (
        confirmSwitch ? (
          <Banner
            tone="warn"
            title="Run the bot from agentpager app?"
            actions={
              <>
                <Button
                  variant="primary"
                  disabled={busy && action.pending !== 'switch'}
                  busy={action.pending === 'switch'}
                  busyLabel={BUSY_LABELS.switch}
                  onClick={() => {
                    void action.run('switch', () => api().daemon.switchToApp()).then(() => {
                      setConfirmSwitch(false);
                    });
                  }}
                >
                  Switch
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setConfirmSwitch(false);
                  }}
                >
                  Cancel
                </Button>
              </>
            }
          >
            The bot will stop for a few seconds, then start again from agentpager app.
          </Banner>
        ) : (
          <Banner
            tone="info"
            title="The bot is running from agentpager cli"
            actions={
              <Button
                disabled={busy}
                onClick={() => {
                  setConfirmSwitch(true);
                }}
              >
                Run the bot from this app
              </Button>
            }
          >
            A bot run by the app is stopped and started again at the right moment when the app updates.
          </Banner>
        )
      ) : null}

      <dl className="details">
        <dt>Bot</dt>
        <dd>{daemon?.botUsername ? `@${daemon.botUsername}` : '—'}</dd>
        <dt>PID daemon</dt>
        <dd>{daemon?.pid ?? '—'}</dd>
        <dt>Uptime</dt>
        <dd>{daemon?.startedAt ? formatDuration(now - new Date(daemon.startedAt).getTime()) : '—'}</dd>
        <dt>Restarts</dt>
        <dd>{daemon ? plural(daemon.restarts, 'time') : '—'}</dd>
        <dt>Last error</dt>
        <dd>{lastError ?? '—'}</dd>
        <dt>Agent CLI</dt>
        <dd>
          {detection === null
            ? '—'
            : detection.executable === null
              ? 'bundled with the SDK'
              : `${detection.executable}${detection.version ? ` (${detection.version})` : ''}`}
          {detection?.problems.map((problem) => (
            <div key={problem} className="warning-text">
              ⚠️ {problem}
            </div>
          ))}
        </dd>
        <dt>Launched by</dt>
        <dd>{daemon ? launcherText(daemon) : '—'}</dd>
      </dl>

      <section className="card" aria-labelledby="autostart-title">
        <h2 id="autostart-title">Autostart</h2>
        {appInfo?.homeOverride ? (
          <p className="muted">{homeOverrideNote(appInfo.homeOverride)}</p>
        ) : autostart === null ? (
          // Reading Task Scheduler takes about a second; an "off" switch in the meantime would be wrong.
          autostartError ? null : <p className="muted" role="status">Reading autostart status…</p>
        ) : (
          <div className="input-row">
            <Toggle
              label="Start the bot at login"
              checked={autostart.enabled}
              disabled={autostartBusy}
              onChange={(enabled) => {
                void setAutostartEnabled(enabled);
              }}
            />
            {autostartBusy ? (
              <span className="muted" role="status">
                Applying…
              </span>
            ) : null}
          </div>
        )}
        {autostartError ? <p className="warning-text">⚠️ {autostartError}</p> : null}
        {autostart && autostart.problems.length > 0 ? (
          <Banner
            tone="warn"
            title="Autostart needs fixing"
            actions={
              <Button
                disabled={autostartBusy}
                onClick={() => {
                  void setAutostartEnabled(true);
                }}
              >
                Fix autostart
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
            title="Autostart uses another agentpager install"
            actions={
              <Button
                disabled={autostartBusy}
                onClick={() => {
                  void setAutostartEnabled(true);
                }}
              >
                Switch autostart to this app
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
