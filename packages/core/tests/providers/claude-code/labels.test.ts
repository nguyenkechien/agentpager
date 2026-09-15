import { describe, expect, it } from 'vitest';
import { windowLabel, windowScope } from '../../../src/providers/claude-code/labels.js';

describe('windowLabel', () => {
  it.each([
    ['five_hour', '5-hour'],
    ['seven_day', '7-day'],
    ['seven_day_overage_included', '7-day'],
    ['seven_day_opus', '7-day · Opus'],
    ['seven_day_sonnet', '7-day · Sonnet'],
    ['overage', 'usage credits'],
    ['something_new', 'current'],
    [null, 'current'],
  ])('%s → %s', (key, label) => {
    expect(windowLabel(key)).toBe(label);
  });
});

describe('windowScope', () => {
  it.each([
    ['seven_day_opus', 'model'],
    ['seven_day_sonnet', 'model'],
    ['five_hour', 'global'],
    ['seven_day', 'global'],
    ['overage', 'global'],
    [null, 'global'],
  ])('%s → %s', (key, scope) => {
    expect(windowScope(key)).toBe(scope);
  });
});
