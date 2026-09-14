import type { Logger } from 'pino';
import type {
  ApprovalRequest,
  ApprovalResult,
  AskUserResult,
  InteractionBroker,
  Question,
} from '../../providers/types.js';
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

const TEXT = {
  other: '✍️ Khác',
  done: '✔️ Xong',
  selectedPrefix: '✅ ',
  typeAnswer: 'Gõ câu trả lời của bạn',
  selectAtLeastOne: 'Chọn ít nhất 1 lựa chọn hoặc bấm Khác',
  approvalTitle: '🔐 Agent xin quyền: ',
  allow: '✅ Cho phép',
  deny: '❌ Từ chối',
  allowed: '✅ Đã cho phép',
  denied: '❌ Đã từ chối',
  expired: '⌛ Hết hạn — không có trả lời',
  cancelled: '⏹ Đã huỷ',
  staleCallback: 'Câu hỏi này đã hết hạn',
} as const;

export const PROMPT_MESSAGES = {
  denied: 'User denied this action via Telegram',
  timeout: 'The user did not respond in time. Do not assume an answer; stop and summarize where you are.',
  aborted: 'The turn was cancelled',
  stopped: 'User stopped the turn',
} as const;

type PendingRequest =
  | { kind: 'question'; questions: Question[]; signal: AbortSignal; resolve: (result: AskUserResult) => void }
  | { kind: 'approval'; request: ApprovalRequest; signal: AbortSignal; resolve: (result: ApprovalResult) => void };

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

function decline(request: PendingRequest, message: string): void {
  if (request.kind === 'question') request.resolve({ declined: message });
  else request.resolve({ allow: false, message });
}

export class PromptBroker implements InteractionBroker {
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

  askUser(chatId: number, questions: Question[], signal: AbortSignal): Promise<AskUserResult> {
    return new Promise<AskUserResult>((resolve) => {
      this.enqueue(chatId, { kind: 'question', questions, signal, resolve });
    });
  }

  requestApproval(chatId: number, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve) => {
      this.enqueue(chatId, { kind: 'approval', request, signal, resolve });
    });
  }

  hasPending(chatId: number): boolean {
    return this.active.has(chatId) || (this.waiting.get(chatId)?.length ?? 0) > 0;
  }

  cancelPending(chatId: number): void {
    const queued = this.waiting.get(chatId) ?? [];
    this.waiting.delete(chatId);
    for (const request of queued) decline(request, PROMPT_MESSAGES.stopped);
    const prompt = this.active.get(chatId);
    if (prompt) this.finishDeclined(prompt, PROMPT_MESSAGES.stopped, TEXT.cancelled);
  }

  async consumeText(chatId: number, text: string): Promise<boolean> {
    const prompt = this.active.get(chatId);
    // Text sent before the question message exists is not an answer to it.
    if (prompt?.request.kind !== 'question' || prompt.done || prompt.messageId === null) return false;
    await this.recordAnswer(prompt, prompt.request.questions, text);
    return true;
  }

  async handleCallback(chatId: number, data: string): Promise<CallbackOutcome> {
    const expired: CallbackOutcome = { alert: TEXT.staleCallback };
    const parts = data.split(':');
    const prompt = this.active.get(chatId);
    if (!prompt || prompt.done || parts[1] !== prompt.id) return expired;
    const { request } = prompt;

    if (parts[0] === 'a' && parts.length === 3 && request.kind === 'approval') {
      if (parts[2] === 'y') {
        this.finish(prompt, () => {
          request.resolve({ allow: true });
        }, `${prompt.html}\n\n${TEXT.allowed}`);
        return { alert: null };
      }
      if (parts[2] === 'n') {
        this.finishDeclined(prompt, PROMPT_MESSAGES.denied, `${prompt.html}\n\n${TEXT.denied}`);
        return { alert: null };
      }
      return expired;
    }

    if (parts[0] !== 'q' || parts.length !== 4 || request.kind !== 'question' || parts[2] !== String(prompt.index)) {
      return expired;
    }
    const question = request.questions[prompt.index];
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
      await this.recordAnswer(prompt, request.questions, labels.join(', '));
      return { alert: null };
    }

    if (!/^\d+$/.test(action)) return expired;
    const optionIndex = Number(action);
    const option = question.options[optionIndex];
    if (!option) return expired;

    if (!question.multiSelect) {
      await this.recordAnswer(prompt, request.questions, option.label);
      return { alert: null };
    }

    if (prompt.selected.has(optionIndex)) prompt.selected.delete(optionIndex);
    else prompt.selected.add(optionIndex);
    if (prompt.messageId !== null) {
      await this.safeEdit(chatId, prompt.messageId, prompt.html, this.questionKeyboard(prompt, question));
    }
    return { alert: null };
  }

  private enqueue(chatId: number, request: PendingRequest): void {
    const queue = this.waiting.get(chatId) ?? [];
    queue.push(request);
    this.waiting.set(chatId, queue);
    if (!this.active.has(chatId)) this.startNext(chatId);
  }

  private startNext(chatId: number): void {
    const queue = this.waiting.get(chatId);
    const request = queue?.shift();
    if (queue?.length === 0) this.waiting.delete(chatId);
    if (!request) return;

    if (request.signal.aborted) {
      decline(request, PROMPT_MESSAGES.aborted);
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
        this.finishDeclined(prompt, PROMPT_MESSAGES.timeout, TEXT.expired);
      }, this.timeoutMs),
      onAbort: () => {
        this.finishDeclined(prompt, PROMPT_MESSAGES.aborted, TEXT.cancelled);
      },
      index: 0,
      answers: {},
      selected: new Set(),
    };
    request.signal.addEventListener('abort', prompt.onAbort, { once: true });
    this.active.set(chatId, prompt);
    void this.show(prompt);
  }

  private async show(prompt: ActivePrompt): Promise<void> {
    const { request } = prompt;
    let keyboard: Button[][];
    if (request.kind === 'question') {
      const question = request.questions[prompt.index];
      if (!question) return;
      prompt.html = this.questionHtml(question);
      keyboard = this.questionKeyboard(prompt, question);
    } else {
      prompt.html = this.approvalHtml(request.request);
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
      this.finishDeclined(prompt, `Failed to show the prompt in Telegram: ${(error as Error).message}`, null);
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

  private approvalHtml(request: ApprovalRequest): string {
    const reason = request.reason ? `${escapeHtml(request.reason)}\n` : '';
    return `${TEXT.approvalTitle}${escapeHtml(request.title)}\n${reason}<pre>${escapeHtml(request.summary)}</pre>`;
  }

  private async recordAnswer(prompt: ActivePrompt, questions: Question[], answer: string): Promise<void> {
    const question = questions[prompt.index];
    if (!question) return;

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
    const { request } = prompt;
    this.finish(
      prompt,
      () => {
        if (request.kind === 'question') request.resolve({ answers: { ...prompt.answers } });
      },
      null,
    );
  }

  private finishDeclined(prompt: ActivePrompt, message: string, finalHtml: string | null): void {
    this.finish(
      prompt,
      () => {
        decline(prompt.request, message);
      },
      finalHtml,
    );
  }

  private finish(prompt: ActivePrompt, settle: () => void, finalHtml: string | null): void {
    if (prompt.done) return;
    prompt.done = true;
    prompt.finalHtml = finalHtml;
    clearTimeout(prompt.timer);
    prompt.request.signal.removeEventListener('abort', prompt.onAbort);
    if (this.active.get(prompt.chatId) === prompt) this.active.delete(prompt.chatId);

    if (finalHtml !== null && prompt.messageId !== null) {
      void this.safeEdit(prompt.chatId, prompt.messageId, finalHtml, null);
    }
    settle();
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
