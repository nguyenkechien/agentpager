import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { InteractionBroker, Question } from '../types.js';

const SUMMARY_LIMIT = 1500;
const INVALID_INPUT_MESSAGE = 'Invalid AskUserQuestion input';

const askUserQuestionSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string(),
        multiSelect: z.boolean().optional(),
        options: z
          .array(z.object({ label: z.string().min(1), description: z.string() }))
          .min(2)
          .max(4),
      }),
    )
    .min(1)
    .max(4),
});

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function summarizeInput(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  return JSON.stringify(input, null, 2);
}

/** Maps Claude Code permission and question requests onto the provider-neutral interaction broker. */
export function createCanUseTool(chatId: number, prompts: InteractionBroker): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    if (toolName === 'AskUserQuestion') {
      const parsed = askUserQuestionSchema.safeParse(input);
      if (!parsed.success) return { behavior: 'deny', message: INVALID_INPUT_MESSAGE };
      const questions: Question[] = parsed.data.questions.map((question) => ({
        question: question.question,
        header: question.header,
        multiSelect: question.multiSelect ?? false,
        options: question.options,
      }));
      const result = await prompts.askUser(chatId, questions, options.signal);
      if ('declined' in result) return { behavior: 'deny', message: result.declined };
      return { behavior: 'allow', updatedInput: { ...input, answers: result.answers } };
    }

    const result = await prompts.requestApproval(
      chatId,
      {
        title: options.title ?? toolName,
        reason: options.decisionReason ?? null,
        summary: truncate(summarizeInput(input), SUMMARY_LIMIT),
      },
      options.signal,
    );
    return result.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: result.message };
  };
}
