import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';
import { z } from 'zod';
import { escapeHtml } from '../bot/render.js';

export interface Button {
  text: string;
  data: string;
}

export interface PromptUi {
  sendPrompt(chatId: number, html: string, keyboard: Button[][]): Promise<number>;
  editPrompt(chatId: number, messageId: number, html: string, keyboard: Button[][] | null): Promise<void>;
  sendNotice(chatId: number, text: string): Promise<void>;
}

export interface CallbackOutcome {
  alert: string | null;
}

type CanUseToolOptions = Parameters<CanUseTool>[2];

const TEXT = {
  other: '✍️ Khác',
  done: '✔️ Xong',
  selectedPrefix: '✅ ',
  typeAnswer: 'Gõ câu trả lời của bạn',
  selectAtLeastOne: 'Chọn ít nhất 1 lựa chọn hoặc bấm Khác',
  approvalTitle: '🔐 Claude xin quyền: ',
  allow: '✅ Cho phép',
  deny: '❌ Từ chối',
  allowed: '✅ Đã cho phép',
  denied: '❌ Đã từ chối',
  expired: '⌛ Hết hạn — không có trả lời',
  cancelled: '⏹ Đã huỷ',
  staleCallback: 'Câu hỏi này đã hết hạn',
} as const;

const MESSAGES = {
  invalidInput: 'Invalid AskUserQuestion input',
  denied: 'User denied this action via Telegram',
  timeout: 'The user did not respond in time. Do not assume an answer; stop and summarize where you are.',
  aborted: 'The turn was cancelled',
  stopped: 'User stopped the turn',
} as const;

const SUMMARY_LIMIT = 1500;

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

type Question = z.infer<typeof askUserQuestionSchema>['questions'][number];

interface PendingRequest {
  toolName: string;
  input: Record<string, unknown>;
  questions: Question[] | null;
  options: CanUseToolOptions;
  resolve: (result: PermissionResult) => void;
}

interface ActivePrompt {
  id: string;
  chatId: number;
  request: PendingRequest;
  messageId: number | null;
  html: string;
  done: boolean;
  finalHtml: string | null;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  // Question state
  index: number;
  answers: Record<string, string>;
  selected: Set<number>;
}

function defaultId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function summarizeInput(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  return JSON.stringify(input, null, 2);
}

export class PromptBroker {
  private readonly active = new Map<number, ActivePrompt>();
  private readonly waiting = new Map<number, PendingRequest[]>();
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly newId: () => string;

  constructor(
    private readonly ui: PromptUi,
    options: { timeoutMs: number; logger: Logger; newId?: () => string },
  ) {
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
    this.newId = options.newId ?? defaultId;
  }

  canUseToolFor(chatId: number): CanUseTool {
    return (toolName, input, options) => {
      let questions: Question[] | null = null;
      if (toolName === 'AskUserQuestion') {
        const parsed = askUserQuestionSchema.safeParse(input);
        if (!parsed.success) {
          this.logger.warn({ chatId, issues: parsed.error.issues }, 'invalid AskUserQuestion input');
          return Promise.resolve({ behavior: 'deny', message: MESSAGES.invalidInput });
        }
        questions = parsed.data.questions;
      }
      return new Promise<PermissionResult>((resolve) => {
        const queue = this.waiting.get(chatId) ?? [];
        queue.push({ toolName, input, questions, options, resolve });
        this.waiting.set(chatId, queue);
        if (!this.active.has(chatId)) this.startNext(chatId);
      });
    };
  }

  hasPending(chatId: number): boolean {
    return this.active.has(chatId) || (this.waiting.get(chatId)?.length ?? 0) > 0;
  }

  cancelPending(chatId: number): void {
    const queued = this.waiting.get(chatId) ?? [];
    this.waiting.delete(chatId);
    for (const request of queued) request.resolve({ behavior: 'deny', message: MESSAGES.stopped });
    const prompt = this.active.get(chatId);
    if (prompt) this.finish(prompt, { behavior: 'deny', message: MESSAGES.stopped }, TEXT.cancelled);
  }

  async consumeText(chatId: number, text: string): Promise<boolean> {
    const prompt = this.active.get(chatId);
    // Text sent before the question message exists is not an answer to it.
    if (!prompt?.request.questions || prompt.done || prompt.messageId === null) return false;
    await this.recordAnswer(prompt, text);
    return true;
  }

  async handleCallback(chatId: number, data: string): Promise<CallbackOutcome> {
    const expired: CallbackOutcome = { alert: TEXT.staleCallback };
    const parts = data.split(':');
    const prompt = this.active.get(chatId);
    if (!prompt || prompt.done || parts[1] !== prompt.id) return expired;

    if (parts[0] === 'a' && parts.length === 3 && !prompt.request.questions) {
      if (parts[2] === 'y') {
        this.finish(prompt, { behavior: 'allow', updatedInput: prompt.request.input }, `${prompt.html}\n\n${TEXT.allowed}`);
        return { alert: null };
      }
      if (parts[2] === 'n') {
        this.finish(prompt, { behavior: 'deny', message: MESSAGES.denied }, `${prompt.html}\n\n${TEXT.denied}`);
        return { alert: null };
      }
      return expired;
    }

    const questions = prompt.request.questions;
    if (parts[0] !== 'q' || parts.length !== 4 || !questions || parts[2] !== String(prompt.index)) return expired;
    const question = questions[prompt.index];
    if (!question) return expired;
    const action = parts[3] ?? '';

    if (action === 'other') {
      await this.ui.sendNotice(chatId, TEXT.typeAnswer);
      return { alert: null };
    }

    if (action === 'done') {
      if (!question.multiSelect) return expired;
      if (prompt.selected.size === 0) return { alert: TEXT.selectAtLeastOne };
      const labels = question.options.filter((_, index) => prompt.selected.has(index)).map((option) => option.label);
      await this.recordAnswer(prompt, labels.join(', '));
      return { alert: null };
    }

    if (!/^\d+$/.test(action)) return expired;
    const optionIndex = Number(action);
    const option = question.options[optionIndex];
    if (!option) return expired;

    if (!question.multiSelect) {
      await this.recordAnswer(prompt, option.label);
      return { alert: null };
    }

    if (prompt.selected.has(optionIndex)) prompt.selected.delete(optionIndex);
    else prompt.selected.add(optionIndex);
    if (prompt.messageId !== null) {
      await this.safeEdit(chatId, prompt.messageId, prompt.html, this.questionKeyboard(prompt, question));
    }
    return { alert: null };
  }

  private startNext(chatId: number): void {
    const queue = this.waiting.get(chatId);
    const request = queue?.shift();
    if (queue?.length === 0) this.waiting.delete(chatId);
    if (!request) return;

    if (request.options.signal.aborted) {
      request.resolve({ behavior: 'deny', message: MESSAGES.aborted });
      this.startNext(chatId);
      return;
    }

    const prompt: ActivePrompt = {
      id: this.newId(),
      chatId,
      request,
      messageId: null,
      html: '',
      done: false,
      finalHtml: null,
      timer: setTimeout(() => {
        this.finish(prompt, { behavior: 'deny', message: MESSAGES.timeout }, TEXT.expired);
      }, this.timeoutMs),
      onAbort: () => {
        this.finish(prompt, { behavior: 'deny', message: MESSAGES.aborted }, TEXT.cancelled);
      },
      index: 0,
      answers: {},
      selected: new Set(),
    };
    request.options.signal.addEventListener('abort', prompt.onAbort, { once: true });
    this.active.set(chatId, prompt);
    void this.show(prompt);
  }

  private async show(prompt: ActivePrompt): Promise<void> {
    const { questions } = prompt.request;
    let keyboard: Button[][];
    if (questions) {
      const question = questions[prompt.index];
      if (!question) return;
      prompt.html = this.questionHtml(question);
      keyboard = this.questionKeyboard(prompt, question);
    } else {
      prompt.html = this.approvalHtml(prompt.request);
      keyboard = [
        [
          { text: TEXT.allow, data: `a:${prompt.id}:y` },
          { text: TEXT.deny, data: `a:${prompt.id}:n` },
        ],
      ];
    }

    try {
      prompt.messageId = await this.ui.sendPrompt(prompt.chatId, prompt.html, keyboard);
    } catch (error) {
      this.logger.error({ err: error, chatId: prompt.chatId }, 'failed to show prompt in Telegram');
      this.finish(prompt, { behavior: 'deny', message: `Failed to show the prompt in Telegram: ${(error as Error).message}` }, null);
      return;
    }
    // The prompt may have been resolved (timeout, abort, stop) while the message was being sent.
    if (prompt.done && prompt.finalHtml !== null) {
      await this.safeEdit(prompt.chatId, prompt.messageId, prompt.finalHtml, null);
    }
  }

  private questionHtml(question: Question): string {
    const options = question.options.map((option) => `• ${escapeHtml(option.label)} — ${escapeHtml(option.description)}`);
    return `❓ <b>${escapeHtml(question.header)}</b>\n${escapeHtml(question.question)}\n\n${options.join('\n')}`;
  }

  private questionKeyboard(prompt: ActivePrompt, question: Question): Button[][] {
    const rows: Button[][] = question.options.map((option, index) => [
      {
        text: prompt.selected.has(index) ? `${TEXT.selectedPrefix}${option.label}` : option.label,
        data: `q:${prompt.id}:${prompt.index}:${index}`,
      },
    ]);
    const other = { text: TEXT.other, data: `q:${prompt.id}:${prompt.index}:other` };
    rows.push(question.multiSelect ? [{ text: TEXT.done, data: `q:${prompt.id}:${prompt.index}:done` }, other] : [other]);
    return rows;
  }

  private approvalHtml(request: PendingRequest): string {
    const title = request.options.title ?? request.toolName;
    const reason = request.options.decisionReason ? `${escapeHtml(request.options.decisionReason)}\n` : '';
    const summary = escapeHtml(truncate(summarizeInput(request.input), SUMMARY_LIMIT));
    return `${TEXT.approvalTitle}${escapeHtml(title)}\n${reason}<pre>${summary}</pre>`;
  }

  private async recordAnswer(prompt: ActivePrompt, answer: string): Promise<void> {
    const questions = prompt.request.questions;
    const question = questions?.[prompt.index];
    if (!questions || !question) return;

    prompt.answers[question.question] = answer;
    if (prompt.messageId !== null) {
      await this.safeEdit(
        prompt.chatId,
        prompt.messageId,
        `❓ ${escapeHtml(question.question)}\n→ ${escapeHtml(answer)}`,
        null,
      );
    }
    if (prompt.done) return;

    prompt.index += 1;
    prompt.selected.clear();
    if (prompt.index < questions.length) {
      prompt.messageId = null;
      await this.show(prompt);
      return;
    }
    this.finish(
      prompt,
      { behavior: 'allow', updatedInput: { ...prompt.request.input, answers: prompt.answers } },
      null,
    );
  }

  private finish(prompt: ActivePrompt, result: PermissionResult, finalHtml: string | null): void {
    if (prompt.done) return;
    prompt.done = true;
    prompt.finalHtml = finalHtml;
    clearTimeout(prompt.timer);
    prompt.request.options.signal.removeEventListener('abort', prompt.onAbort);
    if (this.active.get(prompt.chatId) === prompt) this.active.delete(prompt.chatId);

    if (finalHtml !== null && prompt.messageId !== null) {
      void this.safeEdit(prompt.chatId, prompt.messageId, finalHtml, null);
    }
    prompt.request.resolve(result);
    this.startNext(prompt.chatId);
  }

  private async safeEdit(chatId: number, messageId: number, html: string, keyboard: Button[][] | null): Promise<void> {
    try {
      await this.ui.editPrompt(chatId, messageId, html, keyboard);
    } catch (error) {
      this.logger.warn({ err: error, chatId, messageId }, 'failed to edit prompt message');
    }
  }
}
