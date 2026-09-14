import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnEvent, TurnInput, TurnOutcome } from '../types.js';
import { windowLabel, windowScope } from './labels.js';

/** `resetsAt` comes from the unified reset header in epoch seconds; accept milliseconds too. */
function epochToMs(value: number | undefined): number | null {
  if (value === undefined) return null;
  return value < 1e12 ? value * 1000 : value;
}

/** Header utilization may be a 0–1 fraction while the usage endpoint reports percent. */
function toPercent(value: number | undefined): number | null {
  if (value === undefined) return null;
  return Math.round(value <= 1 ? value * 100 : value);
}

export function eventsFromMessage(message: SDKMessage): TurnEvent[] {
  if (message.type === 'system' && message.subtype === 'init') {
    return [{ type: 'session', sessionId: message.session_id }, { type: 'activity' }];
  }
  if (message.type === 'system' && message.subtype === 'api_retry') {
    return [
      { type: 'activity' },
      {
        type: 'api_retry',
        attempt: message.attempt,
        maxRetries: message.max_retries,
        delayMs: message.retry_delay_ms,
        error: message.error,
      },
    ];
  }
  if (message.type === 'rate_limit_event') {
    const info = message.rate_limit_info;
    const key = info.rateLimitType ?? null;
    return [
      { type: 'activity' },
      {
        type: 'rate_limit',
        snapshot: {
          status: info.status,
          windowKey: key,
          windowLabel: windowLabel(key),
          scope: windowScope(key),
          resetsAtMs: epochToMs(info.resetsAt),
          utilizationPercent: toPercent(info.utilization),
          threshold: info.surpassedThreshold ?? null,
        },
      },
    ];
  }
  if (message.type === 'assistant') {
    const events: TurnEvent[] = [{ type: 'activity' }];
    for (const block of message.message.content) {
      if (block.type === 'tool_use') events.push({ type: 'tool', name: block.name });
    }
    if (message.error === 'rate_limit' || message.error === 'billing_error') events.push({ type: 'limit_error' });
    return events;
  }
  if (message.type === 'result') {
    const events: TurnEvent[] = [{ type: 'activity' }, { type: 'result' }];
    if (message.terminal_reason === 'blocking_limit') events.push({ type: 'limit_error' });
    return events;
  }
  return [{ type: 'activity' }];
}

export function outcomeFromMessage(message: SDKMessage): TurnOutcome | null {
  if (message.type !== 'result') return null;
  if (message.subtype === 'success') {
    return { kind: 'success', text: message.result, costUsd: message.total_cost_usd };
  }
  return { kind: 'error', subtype: message.subtype, errors: message.errors, costUsd: message.total_cost_usd };
}

export function buildUserMessage(input: TurnInput): SDKUserMessage {
  if (input.kind === 'text') {
    return { type: 'user', message: { role: 'user', content: input.text }, parent_tool_use_id: null };
  }
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.imageBase64 } },
        { type: 'text', text: input.text },
      ],
    },
    parent_tool_use_id: null,
  };
}
