import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { buildUserMessage, eventsFromMessage, outcomeFromMessage } from '../../../src/providers/claude-code/events.js';

function sdkMessage(value: Record<string, unknown>): SDKMessage {
  return value as unknown as SDKMessage;
}

const initMessage = sdkMessage({ type: 'system', subtype: 'init', session_id: 's1', cwd: 'D:\\Projects' });
const assistantMessage = sdkMessage({
  type: 'assistant',
  session_id: 's1',
  parent_tool_use_id: null,
  message: {
    content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a' } },
    ],
  },
});
const successMessage = sdkMessage({
  type: 'result',
  subtype: 'success',
  result: 'done',
  total_cost_usd: 0.12,
  session_id: 's1',
});
const errorMessage = sdkMessage({
  type: 'result',
  subtype: 'error_max_turns',
  errors: ['too many turns'],
  total_cost_usd: 0.5,
  session_id: 's1',
});

describe('eventsFromMessage', () => {
  it('emits the session id on init', () => {
    expect(eventsFromMessage(initMessage)).toEqual([{ type: 'session', sessionId: 's1' }, { type: 'activity' }]);
  });

  it('emits activity and one tool event per tool_use block', () => {
    expect(eventsFromMessage(assistantMessage)).toEqual([
      { type: 'activity' },
      { type: 'tool', name: 'Bash' },
      { type: 'tool', name: 'Read' },
    ]);
  });

  it('marks result messages', () => {
    expect(eventsFromMessage(successMessage)).toEqual([{ type: 'activity' }, { type: 'result' }]);
    expect(eventsFromMessage(errorMessage)).toEqual([{ type: 'activity' }, { type: 'result' }]);
  });

  it('converts rate limit events to milliseconds and percent', () => {
    expect(
      eventsFromMessage(
        sdkMessage({
          type: 'rate_limit_event',
          session_id: 's1',
          rate_limit_info: {
            status: 'allowed_warning',
            rateLimitType: 'five_hour',
            resetsAt: 1_789_370_400,
            utilization: 0.85,
            surpassedThreshold: 0.8,
          },
        }),
      ),
    ).toEqual([
      { type: 'activity' },
      {
        type: 'rate_limit',
        snapshot: {
          status: 'allowed_warning',
          windowKey: 'five_hour',
          windowLabel: '5-hour',
          scope: 'global',
          resetsAtMs: 1_789_370_400_000,
          utilizationPercent: 85,
          threshold: 0.8,
        },
      },
    ]);
    expect(
      eventsFromMessage(
        sdkMessage({ type: 'rate_limit_event', session_id: 's1', rate_limit_info: { status: 'rejected', utilization: 100 } }),
      ),
    ).toEqual([
      { type: 'activity' },
      {
        type: 'rate_limit',
        snapshot: {
          status: 'rejected',
          windowKey: null,
          windowLabel: 'current',
          scope: 'global',
          resetsAtMs: null,
          utilizationPercent: 100,
          threshold: null,
        },
      },
    ]);
  });

  it('marks model-scoped windows', () => {
    expect(
      eventsFromMessage(
        sdkMessage({
          type: 'rate_limit_event',
          session_id: 's1',
          rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1_789_370_400_000 },
        }),
      ),
    ).toEqual([
      { type: 'activity' },
      {
        type: 'rate_limit',
        snapshot: {
          status: 'rejected',
          windowKey: 'seven_day_opus',
          windowLabel: '7-day · Opus',
          scope: 'model',
          resetsAtMs: 1_789_370_400_000,
          utilizationPercent: null,
          threshold: null,
        },
      },
    ]);
  });

  it('maps API retries', () => {
    expect(
      eventsFromMessage(
        sdkMessage({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 4000,
          error_status: 529,
          error: 'overloaded',
          session_id: 's1',
        }),
      ),
    ).toEqual([{ type: 'activity' }, { type: 'api_retry', attempt: 2, maxRetries: 10, delayMs: 4000, error: 'overloaded' }]);
  });

  it('flags limit errors on assistant messages and blocking results', () => {
    expect(
      eventsFromMessage(
        sdkMessage({ type: 'assistant', session_id: 's1', parent_tool_use_id: null, error: 'rate_limit', message: { content: [] } }),
      ),
    ).toEqual([{ type: 'activity' }, { type: 'limit_error' }]);
    expect(
      eventsFromMessage(
        sdkMessage({ type: 'result', subtype: 'success', result: 'x', total_cost_usd: 0, terminal_reason: 'blocking_limit' }),
      ),
    ).toEqual([{ type: 'activity' }, { type: 'result' }, { type: 'limit_error' }]);
  });

  it('emits plain activity for other messages', () => {
    expect(eventsFromMessage(sdkMessage({ type: 'system', subtype: 'status', session_id: 's1' }))).toEqual([
      { type: 'activity' },
    ]);
  });
});

describe('outcomeFromMessage', () => {
  it('maps success and error results', () => {
    expect(outcomeFromMessage(successMessage)).toEqual({ kind: 'success', text: 'done', costUsd: 0.12 });
    expect(outcomeFromMessage(errorMessage)).toEqual({
      kind: 'error',
      subtype: 'error_max_turns',
      errors: ['too many turns'],
      costUsd: 0.5,
    });
  });

  it('returns null for non-result messages', () => {
    expect(outcomeFromMessage(assistantMessage)).toBeNull();
  });
});

describe('buildUserMessage', () => {
  it('builds a text message', () => {
    expect(buildUserMessage({ kind: 'text', text: 'hi' })).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      parent_tool_use_id: null,
    });
  });

  it('puts the image block before the text block', () => {
    expect(buildUserMessage({ kind: 'photo', imageBase64: 'AAA', mediaType: 'image/jpeg', imagePath: 'D:\\up\\a.jpg', text: 'caption' })).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
          { type: 'text', text: 'caption' },
        ],
      },
      parent_tool_use_id: null,
    });
  });
});
