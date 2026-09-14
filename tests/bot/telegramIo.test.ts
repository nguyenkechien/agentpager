import { GrammyError, InputFile } from 'grammy';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramIo, type TelegramApiLike } from '../../src/bot/telegramIo.js';

type Options = Record<string, unknown>;

function fakeApi() {
  let nextId = 500;
  return {
    sendMessage: vi.fn<(chatId: number, text: string, other?: Options) => Promise<{ message_id: number }>>(() =>
      Promise.resolve({ message_id: nextId++ }),
    ),
    editMessageText: vi.fn<(chatId: number, messageId: number, text: string, other?: Options) => Promise<true>>(() =>
      Promise.resolve(true),
    ),
    sendChatAction: vi.fn<(chatId: number, action: string) => Promise<true>>(() => Promise.resolve(true)),
    sendDocument: vi.fn<(chatId: number, file: InputFile, other?: Options) => Promise<{ message_id: number }>>(() =>
      Promise.resolve({ message_id: 1 }),
    ),
    sendPhoto: vi.fn<(chatId: number, file: InputFile, other?: Options) => Promise<{ message_id: number }>>(() =>
      Promise.resolve({ message_id: 2 }),
    ),
  };
}

const logger = pino({ level: 'silent' });
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

function create(api: ReturnType<typeof fakeApi>): TelegramIo {
  return new TelegramIo(api as unknown as TelegramApiLike, logger);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sendMarkdown', () => {
  it('sends rendered HTML', async () => {
    const api = fakeApi();
    await create(api).sendMarkdown(7, '**hi**');
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(7, '<b>hi</b>', HTML);
  });

  it('sends every chunk when the response fits in four messages', async () => {
    const api = fakeApi();
    const paragraph = 'x'.repeat(3000);
    await create(api).sendMarkdown(7, [paragraph, paragraph, paragraph].join('\n\n'));
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it('sends the first chunk plus a Markdown file for long responses', async () => {
    const api = fakeApi();
    const paragraph = 'y'.repeat(3000);
    const markdown = Array.from({ length: 5 }, () => paragraph).join('\n\n');
    await create(api).sendMarkdown(7, markdown);

    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendDocument).toHaveBeenCalledOnce();
    const [chatId, file, other] = api.sendDocument.mock.calls[0] ?? [];
    expect(chatId).toBe(7);
    expect(file).toBeInstanceOf(InputFile);
    expect(file?.filename).toMatch(/^response-\d+\.md$/);
    expect(other).toEqual({ caption: 'Phản hồi dài — xem file' });
  });

  it('falls back to plain text when Telegram cannot parse the HTML', async () => {
    const api = fakeApi();
    api.sendMessage.mockRejectedValueOnce(
      new GrammyError(
        'Call to sendMessage failed',
        { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unexpected end tag" },
        'sendMessage',
        {},
      ),
    );
    await create(api).sendMarkdown(7, '**a & b**');
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenLastCalledWith(7, 'a & b', { link_preview_options: { is_disabled: true } });
  });

  it('rethrows other errors', async () => {
    const api = fakeApi();
    api.sendMessage.mockRejectedValueOnce(new Error('network down'));
    await expect(create(api).sendMarkdown(7, 'hello')).rejects.toThrow('network down');
  });

  it('sends nothing for empty markdown', async () => {
    const api = fakeApi();
    await create(api).sendMarkdown(7, '  ');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('notices, prompts and files', () => {
  it('sends notices as plain text', async () => {
    const api = fakeApi();
    await create(api).sendNotice(7, 'hello <x>');
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(7, 'hello <x>', { link_preview_options: { is_disabled: true } });
  });

  it('sends prompts with an inline keyboard and returns the message id', async () => {
    const api = fakeApi();
    const id = await create(api).sendPrompt(7, '<b>Q</b>', [[{ text: 'A', data: 'q:1:0:0' }]]);
    expect(id).toBe(500);
    expect(api.sendMessage).toHaveBeenCalledWith(7, '<b>Q</b>', {
      ...HTML,
      reply_markup: { inline_keyboard: [[{ text: 'A', callback_data: 'q:1:0:0' }]] },
    });
  });

  it('removes the keyboard when editing with null', async () => {
    const api = fakeApi();
    await create(api).editPrompt(7, 9, 'done', null);
    expect(api.editMessageText).toHaveBeenCalledWith(7, 9, 'done', { ...HTML, reply_markup: { inline_keyboard: [] } });
  });

  it('uploads photos and documents from disk', async () => {
    const api = fakeApi();
    const io = create(api);
    await io.sendPhoto(7, 'C:\\shot.png', 'look');
    await io.sendDocument(7, 'C:\\log.txt', undefined);
    expect(api.sendPhoto.mock.calls[0]?.[1]).toBeInstanceOf(InputFile);
    expect(api.sendPhoto.mock.calls[0]?.[2]).toEqual({ caption: 'look' });
    expect(api.sendDocument.mock.calls[0]?.[2]).toEqual({});
  });
});

describe('setTyping', () => {
  it('repeats the typing action until turned off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const api = fakeApi();
    const io = create(api);

    io.setTyping(7, true);
    io.setTyping(7, true);
    expect(api.sendChatAction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(api.sendChatAction).toHaveBeenCalledTimes(3);

    io.setTyping(7, false);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(api.sendChatAction).toHaveBeenCalledTimes(3);
    expect(api.sendChatAction).toHaveBeenCalledWith(7, 'typing');
  });
});
