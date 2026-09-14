const LABELS: Record<string, string> = {
  five_hour: '5 giờ',
  seven_day: '7 ngày',
  seven_day_overage_included: '7 ngày',
  seven_day_opus: '7 ngày · Opus',
  seven_day_sonnet: '7 ngày · Sonnet',
  overage: 'usage credits',
};

const MODEL_SCOPED = new Set(['seven_day_opus', 'seven_day_sonnet']);

export function windowLabel(key: string | null): string {
  return (key !== null ? LABELS[key] : undefined) ?? 'hiện tại';
}

export function windowScope(key: string | null): 'global' | 'model' {
  return key !== null && MODEL_SCOPED.has(key) ? 'model' : 'global';
}
