import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createCanUseTool } from '../../../src/providers/claude-code/canUseTool.js';
import type { ApprovalResult, AskUserResult, InteractionBroker } from '../../../src/providers/types.js';

type CallOptions = Parameters<CanUseTool>[2];

const CHAT = 7;

function callOptions(extra: Partial<CallOptions> = {}): CallOptions {
  return { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'req-1', ...extra };
}

function fakeBroker(answer: AskUserResult, approval: ApprovalResult) {
  const askUser = vi.fn<InteractionBroker['askUser']>(() => Promise.resolve(answer));
  const requestApproval = vi.fn<InteractionBroker['requestApproval']>(() => Promise.resolve(approval));
  const broker: InteractionBroker = { askUser, requestApproval };
  return { broker, askUser, requestApproval };
}

const questionInput = {
  questions: [
    {
      question: 'Which DB?',
      header: 'DB',
      options: [
        { label: 'Postgres', description: 'relational' },
        { label: 'Mongo', description: 'document' },
      ],
    },
  ],
};

describe('createCanUseTool AskUserQuestion', () => {
  it('asks the broker with normalized questions and returns the answers as updated input', async () => {
    const { broker, askUser } = fakeBroker({ answers: { 'Which DB?': 'Mongo' } }, { allow: true });
    const options = callOptions();
    const result = await createCanUseTool(CHAT, broker)('AskUserQuestion', questionInput, options);

    expect(askUser).toHaveBeenCalledWith(
      CHAT,
      [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: questionInput.questions[0]?.options }],
      options.signal,
    );
    expect(result).toEqual({ behavior: 'allow', updatedInput: { ...questionInput, answers: { 'Which DB?': 'Mongo' } } });
  });

  it('denies with the decline message', async () => {
    const { broker } = fakeBroker({ declined: 'User stopped the turn' }, { allow: true });
    await expect(createCanUseTool(CHAT, broker)('AskUserQuestion', questionInput, callOptions())).resolves.toEqual({
      behavior: 'deny',
      message: 'User stopped the turn',
    });
  });

  it('denies invalid input without asking', async () => {
    const { broker, askUser } = fakeBroker({ answers: {} }, { allow: true });
    await expect(createCanUseTool(CHAT, broker)('AskUserQuestion', { questions: [] }, callOptions())).resolves.toEqual({
      behavior: 'deny',
      message: 'Invalid AskUserQuestion input',
    });
    expect(askUser).not.toHaveBeenCalled();
  });
});

describe('createCanUseTool approvals', () => {
  it('uses the SDK title and reason and summarizes shell commands', async () => {
    const { broker, requestApproval } = fakeBroker({ answers: {} }, { allow: true });
    const input = { command: 'rm -rf C:\\x' };
    const result = await createCanUseTool(CHAT, broker)(
      'Bash',
      input,
      callOptions({ title: 'Claude wants to run rm', decisionReason: 'critical path' }),
    );
    expect(requestApproval).toHaveBeenCalledWith(
      CHAT,
      { title: 'Claude wants to run rm', reason: 'critical path', summary: 'rm -rf C:\\x' },
      expect.any(AbortSignal),
    );
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('falls back to the tool name, summarizes file paths and denies with the message', async () => {
    const { broker, requestApproval } = fakeBroker({ answers: {} }, { allow: false, message: 'nope' });
    const result = await createCanUseTool(CHAT, broker)('Write', { file_path: 'C:\\a.txt', content: 'x' }, callOptions());
    expect(requestApproval.mock.calls[0]?.[1]).toEqual({ title: 'Write', reason: null, summary: 'C:\\a.txt' });
    expect(result).toEqual({ behavior: 'deny', message: 'nope' });
  });

  it('truncates long JSON summaries', async () => {
    const { broker, requestApproval } = fakeBroker({ answers: {} }, { allow: true });
    await createCanUseTool(CHAT, broker)('Edit', { blob: 'y'.repeat(5000) }, callOptions());
    const summary = requestApproval.mock.calls[0]?.[1].summary ?? '';
    expect(summary).toHaveLength(1501);
    expect(summary.endsWith('…')).toBe(true);
  });
});
