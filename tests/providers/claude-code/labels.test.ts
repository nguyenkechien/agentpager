import { describe, expect, it } from 'vitest';
import { windowLabel, windowScope } from '../../../src/providers/claude-code/labels.js';

describe('windowLabel', () => {
  it.each([
    ['five_hour', '5 giờ'],
    ['seven_day', '7 ngày'],
    ['seven_day_overage_included', '7 ngày'],
    ['seven_day_opus', '7 ngày · Opus'],
    ['seven_day_sonnet', '7 ngày · Sonnet'],
    ['overage', 'usage credits'],
    ['something_new', 'hiện tại'],
    [null, 'hiện tại'],
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
