import { GrammyError, InputFile, type Api } from 'grammy';
import type { Logger } from 'pino';
import type { Button, PromptUi } from '../claude/prompts.js';
import type { FileSender } from '../claude/tools.js';
import type { Notifier } from '../sessions/manager.js';
import { markdownToTelegramChunks } from './render.js';

export type TelegramApiLike = Pick<Api, 'sendMessage' | 'editMessageText' | 'sendChatAction' | 'sendDocument' | 'sendPhoto'>;

const MAX_INLINE_CHUNKS = 4;
const TYPING_INTERVAL_MS = 4_000;
const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;
const HTML_OPTIONS = { parse_mode: 'HTML', ...NO_PREVIEW } as const;

export function toInlineKeyboard(keyboard: Button[][]): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return { inline_keyboard: keyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) };
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function isParseError(error: unknown): boolean {
  return error instanceof GrammyError && /can't parse entities/i.test(error.description);
}

export class TelegramIo implements Notifier, PromptUi, FileSender {
  private readonly typing = new Map<number, NodeJS.Timeout>();

  constructor(
    private readonly api: TelegramApiLike,
    private readonly logger: Logger,
  ) {}

  async sendMarkdown(chatId: number, markdown: string): Promise<void> {
    const chunks = markdownToTelegramChunks(markdown);
    if (chunks.length === 0) return;

    if (chunks.length > MAX_INLINE_CHUNKS) {
      await this.sendHtml(chatId, chunks[0] ?? '');
      const file = new InputFile(Buffer.from(markdown, 'utf8'), `response-${Date.now()}.md`);
      await this.api.sendDocument(chatId, file, { caption: 'Phản hồi dài — xem file' });
      return;
    }
    for (const chunk of chunks) await this.sendHtml(chatId, chunk);
  }

  async sendNotice(chatId: number, text: string): Promise<void> {
    await this.api.sendMessage(chatId, text, NO_PREVIEW);
  }

  setTyping(chatId: number, active: boolean): void {
    const existing = this.typing.get(chatId);
    if (!active) {
      if (existing) clearInterval(existing);
      this.typing.delete(chatId);
      return;
    }
    if (existing) return;

    const send = (): void => {
      this.api.sendChatAction(chatId, 'typing').catch((error: unknown) => {
        this.logger.warn({ err: error, chatId }, 'failed to send typing action');
      });
    };
    send();
    this.typing.set(chatId, setInterval(send, TYPING_INTERVAL_MS));
  }

  async sendPrompt(chatId: number, html: string, keyboard: Button[][]): Promise<number> {
    const message = await this.api.sendMessage(chatId, html, { ...HTML_OPTIONS, reply_markup: toInlineKeyboard(keyboard) });
    return message.message_id;
  }

  async editPrompt(chatId: number, messageId: number, html: string, keyboard: Button[][] | null): Promise<void> {
    await this.api.editMessageText(chatId, messageId, html, {
      ...HTML_OPTIONS,
      reply_markup: keyboard ? toInlineKeyboard(keyboard) : { inline_keyboard: [] },
    });
  }

  async sendPhoto(chatId: number, filePath: string, caption: string | undefined): Promise<void> {
    await this.api.sendPhoto(chatId, new InputFile(filePath), caption === undefined ? {} : { caption });
  }

  async sendDocument(chatId: number, filePath: string, caption: string | undefined): Promise<void> {
    await this.api.sendDocument(chatId, new InputFile(filePath), caption === undefined ? {} : { caption });
  }

  private async sendHtml(chatId: number, html: string): Promise<void> {
    try {
      await this.api.sendMessage(chatId, html, HTML_OPTIONS);
    } catch (error) {
      if (!isParseError(error)) throw error;
      this.logger.warn({ err: error, chatId, html }, 'Telegram rejected HTML; resending as plain text');
      await this.api.sendMessage(chatId, htmlToPlain(html), NO_PREVIEW);
    }
  }
}
