import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { UsageReport, UsageWindow } from '../types.js';
import { windowScope } from './labels.js';

const DEFAULT_TIMEOUT_MS = 20_000;

const windowSchema = z
  .object({
    utilization: z.number().nullable().optional(),
    resets_at: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const usageResponseSchema = z.object({
  subscription_type: z.string().nullable().optional(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: windowSchema,
      seven_day: windowSchema,
      seven_day_opus: windowSchema,
      seven_day_sonnet: windowSchema,
      model_scoped: z
        .array(
          z.object({
            display_name: z.string(),
            utilization: z.number().nullable().optional(),
            resets_at: z.string().nullable().optional(),
          }),
        )
        .nullable()
        .optional(),
      extra_usage: z.object({ is_enabled: z.boolean().nullable().optional() }).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const PLAN_WINDOWS = [
  ['five_hour', '5 giờ'],
  ['seven_day', '7 ngày'],
  ['seven_day_opus', '7 ngày · Opus'],
  ['seven_day_sonnet', '7 ngày · Sonnet'],
] as const;

function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  // The endpoint sends microseconds; keep milliseconds so every engine parses the value.
  const ms = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(ms) ? null : ms;
}

function percent(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.round(value);
}

export function parseUsageResponse(raw: unknown): UsageReport {
  const parsed = usageResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected usage response');

  const limits = parsed.data.rate_limits;
  const windows: UsageWindow[] = [];
  for (const [key, label] of PLAN_WINDOWS) {
    const window = limits?.[key];
    if (!window) continue;
    windows.push({
      key,
      label,
      scope: windowScope(key),
      utilizationPercent: percent(window.utilization),
      resetsAtMs: isoToMs(window.resets_at),
    });
  }
  for (const scoped of limits?.model_scoped ?? []) {
    windows.push({
      key: `model:${scoped.display_name}`,
      label: `7 ngày · ${scoped.display_name}`,
      scope: 'model',
      utilizationPercent: percent(scoped.utilization),
      resetsAtMs: isoToMs(scoped.resets_at),
    });
  }

  return {
    subscription: parsed.data.subscription_type ?? null,
    available: parsed.data.rate_limits_available,
    extraUsageEnabled: limits?.extra_usage?.is_enabled === true,
    windows,
  };
}

/**
 * Reads plan usage through the SDK's experimental usage control request. A query is started with an input
 * stream that never yields, so no prompt is sent and no tokens are used; the query is closed afterwards.
 */
export class ClaudeUsageFetcher {
  constructor(
    private readonly deps: { executable: string | null; cwd: string; logger: Logger; timeoutMs?: number },
  ) {}

  async fetch(): Promise<UsageReport> {
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let releaseInput: () => void = () => undefined;
    const inputReleased = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    const emptyInput: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({
        next: () => inputReleased.then(() => ({ done: true as const, value: undefined })),
      }),
    };

    const usageQuery = query({
      prompt: emptyInput,
      options: {
        cwd: this.deps.cwd,
        settingSources: [],
        ...(this.deps.executable ? { pathToClaudeCodeExecutable: this.deps.executable } : {}),
      },
    });
    const drained = (async () => {
      for await (const message of usageQuery) this.deps.logger.debug({ type: message.type }, 'usage query message');
    })();

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`hết thời gian chờ (${Math.round(timeoutMs / 1000)} giây)`));
        }, timeoutMs);
      });
      const raw: unknown = await Promise.race([
        usageQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        timeout,
      ]);
      return parseUsageResponse(raw);
    } finally {
      clearTimeout(timer);
      releaseInput();
      usageQuery.close();
      drained.catch((error: unknown) => {
        this.deps.logger.debug({ err: error }, 'usage query stream ended with an error after close');
      });
    }
  }
}
