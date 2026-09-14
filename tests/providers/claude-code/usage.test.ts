import { describe, expect, it } from 'vitest';
import { parseUsageResponse } from '../../../src/providers/claude-code/usage.js';

// Trimmed copy of the payload returned by the CLI during the 2026-09-14 spike (Max account).
const spikePayload = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: {
      utilization: 39,
      resets_at: '2026-09-14T07:40:00.478229+00:00',
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
      locked_reason: null,
    },
    seven_day: { utilization: 46, resets_at: '2026-09-17T14:00:00.478247+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 12, resets_at: null },
    tangelo: { utilization: 1, resets_at: null },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
    spend: { used: { amount_minor: 0 }, percent: 0 },
    model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: '2026-09-17T14:00:00.478439+00:00' }],
  },
  behaviors: null,
};

describe('parseUsageResponse', () => {
  it('extracts the known plan windows in display order', () => {
    expect(parseUsageResponse(spikePayload)).toEqual({
      subscription: 'max',
      available: true,
      extraUsageEnabled: false,
      windows: [
        { key: 'five_hour', label: '5 giờ', scope: 'global', utilizationPercent: 39, resetsAtMs: Date.parse('2026-09-14T07:40:00.478229+00:00') },
        { key: 'seven_day', label: '7 ngày', scope: 'global', utilizationPercent: 46, resetsAtMs: Date.parse('2026-09-17T14:00:00.478247+00:00') },
        { key: 'seven_day_sonnet', label: '7 ngày · Sonnet', scope: 'model', utilizationPercent: 12, resetsAtMs: null },
        { key: 'model:Fable', label: '7 ngày · Fable', scope: 'model', utilizationPercent: 3, resetsAtMs: Date.parse('2026-09-17T14:00:00.478439+00:00') },
      ],
    });
  });

  it('parses fractional seconds in reset timestamps', () => {
    const report = parseUsageResponse(spikePayload);
    expect(Number.isNaN(report.windows[0]?.resetsAtMs)).toBe(false);
    expect(report.windows[0]?.resetsAtMs).toBe(Date.UTC(2026, 8, 14, 7, 40, 0, 478));
  });

  it('handles accounts without plan limits', () => {
    expect(
      parseUsageResponse({ subscription_type: null, rate_limits_available: false, rate_limits: null, session: {} }),
    ).toEqual({ subscription: null, available: false, extraUsageEnabled: false, windows: [] });
  });

  it('reports enabled extra usage', () => {
    const payload = { ...spikePayload, rate_limits: { extra_usage: { is_enabled: true } } };
    expect(parseUsageResponse(payload)).toMatchObject({ extraUsageEnabled: true, windows: [] });
  });

  it('rejects an unexpected payload', () => {
    expect(() => parseUsageResponse('nope')).toThrow('Unexpected usage response');
    expect(() => parseUsageResponse({ rate_limits_available: 'yes' })).toThrow('Unexpected usage response');
  });
});
