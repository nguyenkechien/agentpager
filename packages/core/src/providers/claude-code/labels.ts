const LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: '7-day',
  seven_day_overage_included: '7-day',
  seven_day_opus: '7-day · Opus',
  seven_day_sonnet: '7-day · Sonnet',
  overage: 'usage credits',
};

const MODEL_SCOPED = new Set(['seven_day_opus', 'seven_day_sonnet']);

export function windowLabel(key: string | null): string {
  return (key !== null ? LABELS[key] : undefined) ?? 'current';
}

export function windowScope(key: string | null): 'global' | 'model' {
  return key !== null && MODEL_SCOPED.has(key) ? 'model' : 'global';
}
