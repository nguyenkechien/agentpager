import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';
import type { Effort, GuardRule, ModelAlias } from '../config.js';
import { createGuardHook } from './guard.js';
import type { PromptBroker } from './prompts.js';
import { SYSTEM_PROMPT_APPEND } from './systemPrompt.js';
import { createTelegramMcpServer, type FileSender } from './tools.js';

export type TurnInput =
  | { kind: 'text'; text: string }
  | { kind: 'photo'; imageBase64: string; mediaType: 'image/jpeg'; text: string };

export interface TurnRequest {
  chatId: number;
  cwd: string;
  resumeSessionId: string | null;
  model: ModelAlias | null;
  effort: Effort | null;
  input: TurnInput;
}

export interface RateLimitSnapshot {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  limitType: string | null;
  resetsAtMs: number | null;
  utilizationPercent: number | null;
  threshold: number | null;
}

export type TurnEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'activity' }
  | { type: 'tool'; name: string }
  | { type: 'result' }
  | { type: 'rate_limit'; snapshot: RateLimitSnapshot }
  | { type: 'api_retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  | { type: 'limit_error' };

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

export type TurnOutcome =
  | { kind: 'success'; text: string; costUsd: number }
  | { kind: 'error'; subtype: string; errors: string[]; costUsd: number };

export interface RunningTurn {
  interrupt(): Promise<void>;
  abort(): void;
  readonly done: Promise<TurnOutcome>;
}

export interface Runner {
  start(request: TurnRequest, onEvent: (event: TurnEvent) => void): RunningTurn;
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
    return [
      { type: 'activity' },
      {
        type: 'rate_limit',
        snapshot: {
          status: info.status,
          limitType: info.rateLimitType ?? null,
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

async function* singleMessage(message: SDKUserMessage, turnFinished: Promise<void>): AsyncGenerator<SDKUserMessage> {
  // interrupt() is a control request and requires streaming input, so even text turns are streamed.
  yield message;
  // Keep the input open until the turn has a result: permission responses and interrupts travel over it.
  await turnFinished;
}

export interface SdkRunnerDeps {
  claudeExecutable: string;
  broker: PromptBroker;
  fileSender: FileSender;
  guardRules: readonly GuardRule[];
  onGuardBlock: (chatId: number, command: string, rule: GuardRule) => void;
  logger: Logger;
}

export class SdkRunner implements Runner {
  constructor(private readonly deps: SdkRunnerDeps) {}

  start(request: TurnRequest, onEvent: (event: TurnEvent) => void): RunningTurn {
    const { deps } = this;
    const abortController = new AbortController();
    const guardHook = createGuardHook(deps.guardRules, (command, rule) => {
      deps.onGuardBlock(request.chatId, command, rule);
    });

    let finishInput: () => void = () => undefined;
    const inputFinished = new Promise<void>((resolve) => {
      finishInput = resolve;
    });

    const stream = query({
      prompt: singleMessage(buildUserMessage(request.input), inputFinished),
      options: {
        cwd: request.cwd,
        pathToClaudeCodeExecutable: deps.claudeExecutable,
        ...(request.resumeSessionId ? { resume: request.resumeSessionId } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT_APPEND },
        canUseTool: deps.broker.canUseToolFor(request.chatId),
        mcpServers: { telegram: createTelegramMcpServer(deps.fileSender, request.chatId, request.cwd) },
        hooks: { PreToolUse: [guardHook] },
        abortController,
      },
    });

    const done = (async (): Promise<TurnOutcome> => {
      let outcome: TurnOutcome | null = null;
      try {
        for await (const message of stream) {
          for (const event of eventsFromMessage(message)) onEvent(event);
          if (!outcome) {
            outcome = outcomeFromMessage(message);
            if (outcome) finishInput();
          }
        }
      } finally {
        finishInput();
      }
      if (!outcome) throw new Error('Claude ended without a result');
      return outcome;
    })();

    return {
      done,
      interrupt: async (): Promise<void> => {
        await stream.interrupt();
      },
      abort: (): void => {
        deps.logger.warn({ chatId: request.chatId }, 'aborting Claude turn');
        abortController.abort();
      },
    };
  }
}
