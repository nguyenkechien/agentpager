import { useEffect, useRef, useState } from 'react';
import {
  LOG_LEVEL_NAMES,
  type ConfigView,
  type DaemonView,
  type FieldErrors,
  type LogLevelName,
  type ProviderView,
  type SettingsPatch,
  type UpdateView,
} from '../../shared/api.js';
import { api, unwrap } from '../api.js';
import { Banner, Button, Field, Toggle, useToast } from '../components.js';
import { formatDateTime } from '../format.js';
import { homeOverrideNote } from '../../shared/labels.js';
import { useAction, useAppInfo, useUpdate } from '../hooks.js';

function checkedText(checkedAt: string | null): string {
  return checkedAt === null ? '' : ` · checked ${formatDateTime(checkedAt)}`;
}

export function updateStatusText(view: UpdateView): string {
  switch (view.kind) {
    case 'disabled':
      return view.reason === 'development'
        ? 'Updates are not checked when running from source.'
        : 'Updates are not checked while AGENTPAGER_HOME is set.';
    case 'idle':
      return view.checkedAt === null ? 'Not checked for updates yet.' : `You have the latest version${checkedText(view.checkedAt)}`;
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return `Downloading v${view.version}: ${String(view.percent)}%`;
    case 'ready':
      return `v${view.version} is downloaded and ready to install.`;
    case 'available':
      return `v${view.version} is available${checkedText(view.checkedAt)}`;
    case 'waiting_idle':
      return `v${view.version} will be installed when the agent is idle.`;
    case 'installing':
      return `Installing v${view.version}…`;
    case 'error':
      return `Could not check for updates: ${view.message}`;
  }
}

function VersionSection() {
  const update = useUpdate();
  const check = useAction();
  const view = update.view;
  return (
    <section className="card" aria-labelledby="settings-version-title">
      <h2 id="settings-version-title">Version</h2>
      {view === null ? (
        <p className="muted" role="status">
          Reading version…
        </p>
      ) : (
        <>
          <p>agentpager {view.currentVersion}</p>
          <p className="muted" role="status">
            {updateStatusText(view)}
          </p>
          {view.kind === 'ready' && view.notes !== null ? <pre className="release-notes">{view.notes}</pre> : null}
          <div className="button-row">
            <Button
              disabled={view.kind !== 'idle' && view.kind !== 'error' && view.kind !== 'available'}
              busy={check.pending !== null}
              busyLabel="Checking…"
              onClick={() => {
                void check.run('check', () => api().update.check()).then((next) => {
                  if (next !== null) update.setView(next);
                });
              }}
            >
              Check for updates
            </Button>
          </div>
          {check.error ? <p className="warning-text">⚠️ {check.error.message}</p> : null}
        </>
      )}
    </section>
  );
}

interface FormValues {
  projectsRoot: string;
  idleMinutes: string;
  logLevel: string;
  provider: string;
  /** Empty: use the detected CLI. */
  executable: string;
  /** Empty: the provider's default. */
  defaultModel: string;
  defaultEffort: string;
}

export function formValuesOf(config: ConfigView): FormValues | null {
  if (config.state === 'valid') {
    const { settings } = config;
    return {
      projectsRoot: settings.projectsRoot,
      idleMinutes: String(settings.idleTimeoutMinutes),
      logLevel: settings.logLevel,
      provider: settings.agent.provider,
      executable: settings.agent.executable ?? '',
      defaultModel: settings.agent.defaultModel ?? '',
      defaultEffort: settings.agent.defaultEffort ?? '',
    };
  }
  if (config.state === 'invalid' && config.draft) {
    const { draft } = config;
    return {
      projectsRoot: draft.projectsRoot ?? '',
      idleMinutes: draft.idleTimeoutMinutes === null ? '' : String(draft.idleTimeoutMinutes),
      logLevel: draft.logLevel ?? '',
      provider: draft.agent.provider ?? '',
      executable: draft.agent.executable ?? '',
      defaultModel: draft.agent.defaultModel ?? '',
      defaultEffort: draft.agent.defaultEffort ?? '',
    };
  }
  return null;
}

function isLogLevel(value: string): value is LogLevelName {
  return (LOG_LEVEL_NAMES as readonly string[]).includes(value);
}

/** Only what differs from the values the form started from; local checks first. */
export function buildPatch(baseline: FormValues, values: FormValues, newToken: string | null): { patch: SettingsPatch; errors: FieldErrors } {
  const patch: SettingsPatch = {};
  const errors: FieldErrors = {};
  if (newToken !== null) {
    if (newToken.trim() === '') errors.botToken = ['Enter a new token or cancel the token change.'];
    else patch.botToken = newToken.trim();
  }
  if (values.projectsRoot !== baseline.projectsRoot) patch.projectsRoot = values.projectsRoot.trim();
  if (values.idleMinutes !== baseline.idleMinutes) {
    const trimmed = values.idleMinutes.trim();
    if (/^\d+$/.test(trimmed) && Number(trimmed) >= 1) patch.idleTimeoutMinutes = Number(trimmed);
    else errors.idleTimeoutMinutes = ['Must be a whole number ≥ 1.'];
  }
  if (values.logLevel !== baseline.logLevel) {
    if (isLogLevel(values.logLevel)) patch.logLevel = values.logLevel;
    else errors.logLevel = ['Choose a log level.'];
  }
  const agent: NonNullable<SettingsPatch['agent']> = {};
  if (values.provider !== baseline.provider) agent.provider = values.provider;
  if (values.executable !== baseline.executable) agent.executable = values.executable.trim() === '' ? null : values.executable.trim();
  if (values.defaultModel !== baseline.defaultModel) agent.defaultModel = values.defaultModel === '' ? null : values.defaultModel;
  if (values.defaultEffort !== baseline.defaultEffort) agent.defaultEffort = values.defaultEffort === '' ? null : values.defaultEffort;
  if (Object.keys(agent).length > 0) patch.agent = agent;
  return { patch, errors };
}

function sameValues(a: FormValues | null, b: FormValues | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function SettingsScreen({
  config,
  daemon,
  onRunWizard,
}: {
  config: ConfigView;
  daemon: DaemonView | null;
  onRunWizard: () => void;
}) {
  const toast = useToast();
  const save = useAction();
  const restart = useAction();
  const [baseline, setBaseline] = useState<FormValues | null>(() => formValuesOf(config));
  const [values, setValues] = useState<FormValues | null>(() => formValuesOf(config));
  const [newToken, setNewToken] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>(() => (config.state === 'invalid' ? config.fieldErrors : {}));
  const [externalChange, setExternalChange] = useState<ConfigView | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [confirmWizard, setConfirmWizard] = useState(false);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [trayAtLogin, setTrayAtLogin] = useState<boolean | null>(null);
  const appliedConfig = useRef(config);
  const appInfo = useAppInfo();
  const uninstall = useAction();
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const dirty = newToken !== null || !sameValues(baseline, values);

  useEffect(() => {
    let active = true;
    void unwrap(api().agent.providers()).then(
      (list) => {
        if (active) setProviders(list);
      },
      () => {
        // Without the catalog the selects still show the saved values.
        if (active) setProviders([]);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (appInfo === null || appInfo.homeOverride !== null) return;
    let active = true;
    void api()
      .loginItem.get()
      .then((result) => {
        if (active && result.ok) setTrayAtLogin(result.data);
      });
    return () => {
      active = false;
    };
  }, [appInfo]);

  const adopt = (next: ConfigView): void => {
    appliedConfig.current = next;
    const nextValues = formValuesOf(next);
    setBaseline(nextValues);
    setValues(nextValues);
    setNewToken(null);
    setErrors(next.state === 'invalid' ? next.fieldErrors : {});
    setExternalChange(null);
  };

  // A reload after our own save matches what is on screen; anything else while editing is someone else's change.
  useEffect(() => {
    if (config === appliedConfig.current) return;
    const incoming = formValuesOf(config);
    if (!dirty || sameValues(incoming, values)) adopt(config);
    else setExternalChange(config);
    // Runs only when the config changes: `dirty` and `values` are read as they are at that moment.
  }, [config]);

  const set = (patch: Partial<FormValues>): void => {
    setValues((current) => (current === null ? current : { ...current, ...patch }));
  };

  const submit = async (): Promise<void> => {
    if (baseline === null || values === null) return;
    const built = buildPatch(baseline, values, newToken);
    if (Object.keys(built.errors).length > 0) {
      setErrors(built.errors);
      return;
    }
    if (Object.keys(built.patch).length === 0) {
      toast.show('No changes to save.');
      return;
    }
    const saved = await save.run('save', () => api().config.save(built.patch));
    if (saved === null) return;
    adopt(saved);
    toast.show('Settings saved.');
    if (daemon !== null && daemon.badge !== 'stopped' && daemon.badge !== 'error') setRestartNeeded(true);
  };

  useEffect(() => {
    if (save.error?.fieldErrors) setErrors(save.error.fieldErrors);
  }, [save.error]);

  const pickFolder = async (): Promise<void> => {
    const result = await api().dialog.pickFolder(values?.projectsRoot || null);
    if (result.ok && result.data !== null) set({ projectsRoot: result.data });
  };
  const pickExecutable = async (): Promise<void> => {
    const result = await api().dialog.pickExecutable(values?.executable || null);
    if (result.ok && result.data !== null) set({ executable: result.data });
  };
  const changeTrayAtLogin = async (enabled: boolean): Promise<void> => {
    const previous = trayAtLogin;
    setTrayAtLogin(enabled);
    const result = await api().loginItem.set(enabled);
    if (result.ok) setTrayAtLogin(result.data);
    else {
      setTrayAtLogin(previous);
      toast.show(`Could not change the tray icon at login: ${result.error.message}`, 'error');
    }
  };

  const tokenMasked = config.state === 'valid' ? config.settings.botTokenMasked : config.state === 'invalid' ? (config.draft?.botTokenMasked ?? '—') : '—';
  const provider = providers.find((entry) => entry.id === values?.provider) ?? null;
  const formMessages = [...(errors.form ?? []), ...(errors.allowedUsers ?? [])];

  return (
    <section className="screen" aria-labelledby="settings-title">
      <header className="screen-header">
        <h1 id="settings-title">Settings</h1>
      </header>

      {config.state === 'invalid' ? (
        <Banner
          tone="error"
          title="The current config is invalid"
          actions={
            values === null ? (
              <>
                <Button
                  onClick={() => {
                    void api().shell.openConfigFile();
                  }}
                >
                  Open config file
                </Button>
                <Button
                  onClick={() => {
                    setConfirmWizard(true);
                  }}
                >
                  Run wizard again
                </Button>
              </>
            ) : undefined
          }
        >
          <ul>
            {config.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {confirmWizard ? (
        <Banner
          tone="warn"
          title="Run the wizard again?"
          actions={
            <>
              <Button variant="danger" onClick={onRunWizard}>
                Overwrite and run wizard
              </Button>
              <Button
                onClick={() => {
                  setConfirmWizard(false);
                }}
              >
                Cancel
              </Button>
            </>
          }
        >
          The wizard will overwrite {config.path}.
        </Banner>
      ) : null}

      {externalChange ? (
        <Banner
          tone="warn"
          title="The config was just changed elsewhere"
          actions={
            <>
              <Button
                onClick={() => {
                  adopt(externalChange);
                }}
              >
                Reload
              </Button>
              <Button
                onClick={() => {
                  appliedConfig.current = externalChange;
                  setExternalChange(null);
                }}
              >
                Keep my edits
              </Button>
            </>
          }
        >
          Saving writes only the fields you changed.
        </Banner>
      ) : null}

      {restartNeeded ? (
        <Banner
          tone="info"
          title="Restart to apply"
          actions={
            <Button
              busy={restart.pending !== null}
              busyLabel="Restarting…"
              onClick={() => {
                void restart.run('restart', () => api().daemon.restart()).then((view) => {
                  if (view !== null) setRestartNeeded(false);
                });
              }}
            >
              Restart
            </Button>
          }
        >
          The bot is running with the old settings.
        </Banner>
      ) : null}
      {restart.error ? <Banner tone="error">{restart.error.message}</Banner> : null}

      {values === null ? null : (
        <form
          className="form"
          // The browser's own validation (min=1) would block submit silently; the form shows its Vietnamese messages instead.
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label="Bot token" htmlFor="settings-token" errors={errors.botToken}>
            {newToken === null ? (
              <div className="input-row">
                <code id="settings-token">{tokenMasked}</code>
                <Button
                  onClick={() => {
                    setNewToken('');
                  }}
                >
                  Change token
                </Button>
              </div>
            ) : (
              <div className="input-row">
                <input
                  id="settings-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={newToken}
                  onChange={(event) => {
                    setNewToken(event.target.value);
                  }}
                />
                <Button
                  onClick={() => {
                    setNewToken(null);
                  }}
                >
                  Cancel token change
                </Button>
              </div>
            )}
          </Field>

          <Field label="Projects folder" htmlFor="settings-projects" errors={errors.projectsRoot}>
            <div className="input-row">
              <input
                id="settings-projects"
                value={values.projectsRoot}
                spellCheck={false}
                onChange={(event) => {
                  set({ projectsRoot: event.target.value });
                }}
              />
              <Button
                onClick={() => {
                  void pickFolder();
                }}
              >
                Choose…
              </Button>
            </div>
          </Field>

          <Field label="Session idle timeout (minutes)" htmlFor="settings-idle" errors={errors.idleTimeoutMinutes}>
            <input
              id="settings-idle"
              type="number"
              min={1}
              step={1}
              value={values.idleMinutes}
              onChange={(event) => {
                set({ idleMinutes: event.target.value });
              }}
            />
          </Field>

          <Field label="Log level" htmlFor="settings-log-level" errors={errors.logLevel}>
            <select
              id="settings-log-level"
              value={values.logLevel}
              onChange={(event) => {
                set({ logLevel: event.target.value });
              }}
            >
              {isLogLevel(values.logLevel) ? null : <option value={values.logLevel}>{values.logLevel || '(not set)'}</option>}
              {LOG_LEVEL_NAMES.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Agent" htmlFor="settings-provider" errors={errors['agent.provider']}>
            <select
              id="settings-provider"
              value={values.provider}
              onChange={(event) => {
                set({ provider: event.target.value, defaultModel: '', defaultEffort: '' });
              }}
            >
              {provider === null ? <option value={values.provider}>{values.provider || '(not set)'}</option> : null}
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Agent CLI path" htmlFor="settings-executable" errors={errors['agent.executable']} hint="Leave empty to detect it, or to use the one bundled with the SDK.">
            <div className="input-row">
              <input
                id="settings-executable"
                value={values.executable}
                spellCheck={false}
                onChange={(event) => {
                  set({ executable: event.target.value });
                }}
              />
              <Button
                onClick={() => {
                  void pickExecutable();
                }}
              >
                Choose file…
              </Button>
            </div>
          </Field>

          <Field label="Default model" htmlFor="settings-model" errors={errors['agent.defaultModel']}>
            <select
              id="settings-model"
              value={values.defaultModel}
              onChange={(event) => {
                set({ defaultModel: event.target.value });
              }}
            >
              <option value="">(agent default)</option>
              {provider?.models.some((model) => model.id === values.defaultModel) === false && values.defaultModel !== '' ? (
                <option value={values.defaultModel}>{values.defaultModel}</option>
              ) : null}
              {provider?.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Default effort" htmlFor="settings-effort" errors={errors['agent.defaultEffort']}>
            <select
              id="settings-effort"
              value={values.defaultEffort}
              onChange={(event) => {
                set({ defaultEffort: event.target.value });
              }}
            >
              <option value="">(agent default)</option>
              {provider?.efforts.includes(values.defaultEffort) === false && values.defaultEffort !== '' ? (
                <option value={values.defaultEffort}>{values.defaultEffort}</option>
              ) : null}
              {provider?.efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </Field>

          {formMessages.length > 0 ? (
            <Banner tone="error">
              <ul>
                {formMessages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {save.error && !save.error.fieldErrors ? <Banner tone="error">{save.error.message}</Banner> : null}

          <div className="button-row">
            <Button type="submit" variant="primary" disabled={!dirty} busy={save.pending !== null} busyLabel="Saving…">
              Save
            </Button>
            <Button
              disabled={!dirty || save.pending !== null}
              onClick={() => {
                adopt(appliedConfig.current);
              }}
            >
              Discard changes
            </Button>
          </div>
        </form>
      )}

      <VersionSection />

      <section className="card" aria-labelledby="settings-app-title">
        <h2 id="settings-app-title">App</h2>
        {appInfo?.homeOverride ? (
          <p className="muted">{homeOverrideNote(appInfo.homeOverride)}</p>
        ) : (
          <Toggle
            label="Show tray icon at login"
            checked={trayAtLogin ?? false}
            disabled={trayAtLogin === null}
            onChange={(enabled) => {
              void changeTrayAtLogin(enabled);
            }}
          />
        )}
        {appInfo?.platform === 'darwin' ? (
          confirmUninstall ? (
            <Banner
              tone="warn"
              title="Uninstall agentpager from this computer?"
              actions={
                <>
                  <Button
                    variant="danger"
                    busy={uninstall.pending !== null}
                    busyLabel="Cleaning up…"
                    onClick={() => {
                      void uninstall.run('uninstall', () => api().app.uninstall());
                    }}
                  >
                    Uninstall
                  </Button>
                  <Button
                    disabled={uninstall.pending !== null}
                    onClick={() => {
                      setConfirmUninstall(false);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              }
            >
              The bot run by this app will stop, and autostart and the tray icon at login will be turned off. The bot settings and logs are kept. Finder
              then opens so you can drag agentpager to the Trash.
            </Banner>
          ) : (
            <div className="button-row">
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmUninstall(true);
                }}
              >
                Uninstall agentpager from this computer…
              </Button>
            </div>
          )
        ) : null}
        {uninstall.error ? <Banner tone="error">{uninstall.error.message}</Banner> : null}
      </section>
    </section>
  );
}
