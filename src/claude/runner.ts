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

export type TurnEvent = { type: 'session'; sessionId: string } | { type: 'activity' } | { type: 'tool'; name: string };

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
  if (message.type === 'assistant') {
    const tools: TurnEvent[] = message.message.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ type: 'tool', name: block.name }));
    return [{ type: 'activity' }, ...tools];
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
