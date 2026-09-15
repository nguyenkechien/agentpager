import type { AgentDetectionView, FieldErrors, ProviderView, SettingsField } from '../../../shared/api.js';

export type TokenState =
  | { kind: 'unchecked' }
  | { kind: 'checking' }
  | { kind: 'valid'; username: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'network'; message: string; confirmed: boolean };

export interface WizardData {
  token: string;
  tokenState: TokenState;
  usernames: string[];
  projectsRoot: string;
  providers: ProviderView[];
  provider: string | null;
  /** Chosen by the user; null means "use the detected CLI (or the SDK's bundled one)". */
  executable: string | null;
  detection: AgentDetectionView | null;
  idleMinutes: string;
  autostart: boolean;
  trayAtLogin: boolean;
}

export const INITIAL_WIZARD_DATA: WizardData = {
  token: '',
  tokenState: { kind: 'unchecked' },
  usernames: [],
  projectsRoot: '',
  providers: [],
  provider: null,
  executable: null,
  detection: null,
  idleMinutes: '60',
  autostart: true,
  trayAtLogin: true,
};

export const WIZARD_STEPS = [
  { id: 'token', title: 'Bot token' },
  { id: 'users', title: 'Users' },
  { id: 'projects', title: 'Projects folder' },
  { id: 'agent', title: 'Agent' },
  { id: 'idle', title: 'Session idle timeout' },
  { id: 'finish', title: 'Finish' },
  { id: 'pairing', title: 'Pair accounts' },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

/** Where a save error sends the user back to. */
export const FIELD_STEPS: Record<SettingsField, WizardStepId> = {
  botToken: 'token',
  allowedUsers: 'users',
  projectsRoot: 'projects',
  'agent.provider': 'agent',
  'agent.executable': 'agent',
  'agent.defaultModel': 'agent',
  'agent.defaultEffort': 'agent',
  idleTimeoutMinutes: 'idle',
  logLevel: 'finish',
  form: 'finish',
};

export function parseIdleMinutes(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) && Number(trimmed) >= 1 ? Number(trimmed) : null;
}

export function canContinue(step: WizardStepId, data: WizardData): boolean {
  switch (step) {
    case 'token':
      return data.tokenState.kind === 'valid' || (data.tokenState.kind === 'network' && data.tokenState.confirmed);
    case 'users':
      return data.usernames.length > 0;
    case 'projects':
      return data.projectsRoot.trim() !== '';
    case 'agent':
      return data.provider !== null && data.detection !== null;
    case 'idle':
      return parseIdleMinutes(data.idleMinutes) !== null;
    case 'finish':
    case 'pairing':
      return false;
  }
}

export function firstStepWithErrors(errors: FieldErrors): WizardStepId | null {
  const order = WIZARD_STEPS.map((step) => step.id);
  let best: WizardStepId | null = null;
  for (const [field, messages] of Object.entries(errors) as [SettingsField, string[] | undefined][]) {
    if (!messages || messages.length === 0) continue;
    const step = FIELD_STEPS[field];
    if (best === null || order.indexOf(step) < order.indexOf(best)) best = step;
  }
  return best;
}

export interface StepProps {
  data: WizardData;
  update: (patch: Partial<WizardData>) => void;
  errors?: readonly string[];
}
