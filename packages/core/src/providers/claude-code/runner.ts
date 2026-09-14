import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderContext, ProviderSettings, RunningTurn, TurnOutcome, TurnRequest, TurnSink } from '../types.js';
import { createCanUseTool } from './canUseTool.js';
import { buildUserMessage, eventsFromMessage, outcomeFromMessage } from './events.js';
import { createGuardHook } from './guardHook.js';
import { createSendFileMcpServer } from './sendFileTool.js';

async function* singleMessage(message: SDKUserMessage, turnFinished: Promise<void>): AsyncGenerator<SDKUserMessage> {
  // interrupt() is a control request and requires streaming input, so even text turns are streamed.
  yield message;
  // Keep the input open until the turn has a result: permission responses and interrupts travel over it.
  await turnFinished;
}

export function startClaudeTurn(
  settings: ProviderSettings,
  context: ProviderContext,
  request: TurnRequest,
  sink: TurnSink,
): RunningTurn {
  const abortController = new AbortController();
  let finishInput: () => void = () => undefined;
  const inputFinished = new Promise<void>((resolve) => {
    finishInput = resolve;
  });

  const stream = query({
    prompt: singleMessage(buildUserMessage(request.input), inputFinished),
    options: {
      cwd: request.cwd,
      ...(settings.executable ? { pathToClaudeCodeExecutable: settings.executable } : {}),
      ...(request.resumeSessionId ? { resume: request.resumeSessionId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: context.systemPrompt },
      canUseTool: createCanUseTool(request.chatId, context.prompts),
      mcpServers: { telegram: createSendFileMcpServer(context.fileSender, request.chatId, request.cwd) },
      hooks: { PreToolUse: [createGuardHook(request.chatId, context.guard)] },
      abortController,
    },
  });

  const done = (async (): Promise<TurnOutcome> => {
    let outcome: TurnOutcome | null = null;
    try {
      for await (const message of stream) {
        for (const event of eventsFromMessage(message)) sink.emit(event);
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
      context.logger.warn({ chatId: request.chatId }, 'aborting Claude turn');
      abortController.abort();
    },
  };
}
