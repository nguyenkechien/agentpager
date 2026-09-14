import { useCallback, useEffect, useState } from 'react';
import type { FieldErrors, WizardInput } from '../../../shared/api.js';
import { api, errorOf, unwrap } from '../../api.js';
import { Banner, Button } from '../../components.js';
import { useAppInfo } from '../../hooks.js';
import {
  canContinue,
  firstStepWithErrors,
  INITIAL_WIZARD_DATA,
  parseIdleMinutes,
  WIZARD_STEPS,
  type TokenState,
  type WizardData,
  type WizardStepId,
} from './model.js';
import { AgentStep, FinishStep, IdleStep, PairingStep, ProjectsStep, TokenStep, UsersStep } from './steps.js';

/** First-run setup (and "Chạy lại wizard" with `overwrite`), the same flow as `agentpager setup`. */
export function Wizard({ overwrite, onDone }: { overwrite: boolean; onDone: () => void }) {
  const [step, setStep] = useState<WizardStepId>('token');
  const [data, setData] = useState<WizardData>(INITIAL_WIZARD_DATA);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const homeOverride = useAppInfo()?.homeOverride ?? null;

  const update = useCallback((patch: Partial<WizardData>) => {
    setData((current) => ({ ...current, ...patch }));
  }, []);

  /** A check result only applies to the token it was made for. */
  const setTokenState = useCallback((token: string, tokenState: TokenState) => {
    setData((current) => (current.token === token ? { ...current, tokenState } : current));
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([unwrap(api().config.defaults()), unwrap(api().agent.providers())]).then(
      ([defaults, providers]) => {
        if (!active) return;
        setData((current) => ({
          ...current,
          projectsRoot: current.projectsRoot === '' ? defaults.projectsRoot : current.projectsRoot,
          providers,
          provider: current.provider ?? providers[0]?.id ?? null,
        }));
      },
      (reason: unknown) => {
        if (active) setLoadError(errorOf(reason).message);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const index = WIZARD_STEPS.findIndex((entry) => entry.id === step);
  const move = (offset: number): void => {
    const target = WIZARD_STEPS[index + offset];
    if (target) setStep(target.id);
  };

  const startBot = async (): Promise<boolean> => {
    // Restart applies the new config when a bot is already running, and starts one otherwise.
    const started = await api().daemon.restart();
    if (!started.ok) {
      setStartError(started.error.message);
      return false;
    }
    setStartError(null);
    setBotUsername(started.data.botUsername ?? (data.tokenState.kind === 'valid' ? data.tokenState.username : null));
    return true;
  };

  const save = async (): Promise<void> => {
    const idleTimeoutMinutes = parseIdleMinutes(data.idleMinutes);
    if (idleTimeoutMinutes === null || data.provider === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (!saved) {
        const input: WizardInput = {
          botToken: data.token.trim(),
          usernames: data.usernames,
          projectsRoot: data.projectsRoot.trim(),
          agent: { provider: data.provider, executable: data.executable ?? data.detection?.executable ?? null },
          idleTimeoutMinutes,
        };
        const result = await api().config.runWizard(input, overwrite);
        if (!result.ok) {
          const errors = result.error.fieldErrors ?? {};
          setFieldErrors(errors);
          const target = firstStepWithErrors(errors);
          if (target === null || target === 'finish') setSaveError(result.error.message);
          if (target !== null) setStep(target);
          return;
        }
        setFieldErrors({});
        setSaved(true);
        const problems: string[] = [];
        // Machine-wide settings stay untouched for a separate AGENTPAGER_HOME folder.
        if (homeOverride === null) {
          const autostart = await api().autostart.set(data.autostart);
          if (!autostart.ok) problems.push(`Tự khởi động: ${autostart.error.message}`);
          const loginItem = await api().loginItem.set(data.trayAtLogin);
          if (!loginItem.ok) problems.push(`Icon khay khi đăng nhập: ${loginItem.error.message}`);
        }
        setWarnings(problems);
      }
      if (await startBot()) setStep('pairing');
    } finally {
      setSaving(false);
    }
  };

  const showNav = step !== 'finish' && step !== 'pairing';
  return (
    <div className="wizard-page">
    <main className="wizard" aria-labelledby="wizard-title">
      <header className="wizard-header">
        <h1 id="wizard-title">Thiết lập agentpager</h1>
        <ol className="wizard-steps">
          {WIZARD_STEPS.map((entry, position) => (
            <li key={entry.id} aria-current={entry.id === step ? 'step' : undefined} className={position < index ? 'done' : undefined}>
              {entry.title}
            </li>
          ))}
        </ol>
      </header>
      {loadError ? <Banner tone="error">{loadError}</Banner> : null}
      <section className="wizard-body">
        {step === 'token' ? <TokenStep data={data} update={update} errors={fieldErrors.botToken} setTokenState={setTokenState} /> : null}
        {step === 'users' ? <UsersStep data={data} update={update} errors={fieldErrors.allowedUsers} /> : null}
        {step === 'projects' ? <ProjectsStep data={data} update={update} errors={fieldErrors.projectsRoot} /> : null}
        {step === 'agent' ? <AgentStep data={data} update={update} errors={fieldErrors['agent.executable'] ?? fieldErrors['agent.provider']} /> : null}
        {step === 'idle' ? <IdleStep data={data} update={update} errors={fieldErrors.idleTimeoutMinutes} /> : null}
        {step === 'finish' ? (
          <FinishStep
            data={data}
            update={update}
            saving={saving}
            saved={saved}
            saveError={saveError}
            startError={startError}
            formErrors={fieldErrors.form}
            homeOverride={homeOverride}
            onSave={() => {
              void save();
            }}
          />
        ) : null}
        {step === 'pairing' ? <PairingStep botUsername={botUsername} warnings={warnings} onDone={onDone} /> : null}
      </section>
      {showNav || (step === 'finish' && !saved) ? (
        <footer className="wizard-nav">
          <Button
            disabled={index === 0 || saving}
            onClick={() => {
              move(-1);
            }}
          >
            Quay lại
          </Button>
          {showNav ? (
            <Button
              variant="primary"
              disabled={!canContinue(step, data)}
              onClick={() => {
                move(1);
              }}
            >
              Tiếp
            </Button>
          ) : null}
        </footer>
      ) : null}
    </main>
    </div>
  );
}
