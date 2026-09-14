import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptBroker, type Button, type PromptUi } from '../../src/claude/prompts.js';

class FakeUi implements PromptUi {
  sent: { chatId: number; html: string; keyboard: Button[][]; messageId: number }[] = [];
  edits: { chatId: number; messageId: number; html: string; keyboard: Button[][] | null }[] = [];
  notices: { chatId: number; text: string }[] = [];
  private nextId = 100;

  sendPrompt(chatId: number, html: string, keyboard: Button[][]): Promise<number> {
    const messageId = this.nextId++;
    this.sent.push({ chatId, html, keyboard, messageId });
    return Promise.resolve(messageId);
  }

  editPrompt(chatId: number, messageId: number, html: string, keyboard: Button[][] | null): Promise<void> {
    this.edits.push({ chatId, messageId, html, keyboard });
    return Promise.resolve();
  }

  sendNotice(chatId: number, text: string): Promise<void> {
    this.notices.push({ chatId, text });
    return Promise.resolve();
  }

  lastEdit(): { html: string; keyboard: Button[][] | null } {
    const edit = this.edits.at(-1);
    if (!edit) throw new Error('no edits');
    return edit;
  }
}

const logger = pino({ level: 'silent' });
const CHAT = 7;
const TIMEOUT = 60_000;

const singleQuestion = {
  question: 'Which <DB>?',
  header: 'DB',
  multiSelect: false,
  options: [
    { label: 'Postgres', description: 'relational' },
    { label: 'Mongo', description: 'document' },
  ],
};
const multiQuestion = {
  question: 'Which features?',
  header: 'Features',
  multiSelect: true,
  options: [
    { label: 'Auth', description: 'login' },
    { label: 'Billing', description: 'payments' },
    { label: 'Search', description: 'full text' },
  ],
};

type CallOptions = Parameters<CanUseTool>[2];

function callOptions(extra: Partial<CallOptions> = {}): CallOptions {
  return { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'req-1', ...extra };
}

let ui: FakeUi;
let broker: PromptBroker;
let counter: number;

async function tick(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function ask(input: Record<string, unknown>, chatId = CHAT, signal = new AbortController().signal): Promise<PermissionResult | null> {
  return broker.canUseToolFor(chatId)('AskUserQuestion', input, callOptions({ signal }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  ui = new FakeUi();
  counter = 0;
  broker = new PromptBroker(ui, {
    timeoutMs: TIMEOUT,
    logger,
    newId: () => {
      counter += 1;
      return `p${counter}`;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AskUserQuestion', () => {
  it('renders a single-select question and resolves with the tapped label', async () => {
    const result = ask({ questions: [singleQuestion] });
    await tick();

    expect(broker.hasPending(CHAT)).toBe(true);
    expect(ui.sent).toHaveLength(1);
    expect(ui.sent[0]?.html).toContain('❓ <b>DB</b>');
    expect(ui.sent[0]?.html).toContain('Which &lt;DB&gt;?');
    expect(ui.sent[0]?.html).toContain('• Postgres — relational');
    expect(ui.sent[0]?.keyboard).toEqual([
      [{ text: 'Postgres', data: 'q:p1:0:0' }],
      [{ text: 'Mongo', data: 'q:p1:0:1' }],
      [{ text: '✍️ Khác', data: 'q:p1:0:other' }],
    ]);

    expect(await broker.handleCallback(CHAT, 'q:p1:0:0')).toEqual({ alert: null });
    await expect(result).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { questions: [singleQuestion], answers: { 'Which <DB>?': 'Postgres' } },
    });
    expect(ui.lastEdit()).toMatchObject({ keyboard: null });
    expect(ui.lastEdit().html).toContain('→ Postgres');
    expect(broker.hasPending(CHAT)).toBe(false);
  });

  it('toggles multi-select options and joins the selection on Xong', async () => {
    const result = ask({ questions: [multiQuestion] });
    await tick();
    expect(ui.sent[0]?.keyboard.at(-1)).toEqual([
      { text: '✔️ Xong', data: 'q:p1:0:done' },
      { text: '✍️ Khác', data: 'q:p1:0:other' },
    ]);

    await broker.handleCallback(CHAT, 'q:p1:0:0');
    await broker.handleCallback(CHAT, 'q:p1:0:2');
    await broker.handleCallback(CHAT, 'q:p1:0:0');
    expect(ui.lastEdit().keyboard?.slice(0, 3)).toEqual([
      [{ text: 'Auth', data: 'q:p1:0:0' }],
      [{ text: 'Billing', data: 'q:p1:0:1' }],
      [{ text: '✅ Search', data: 'q:p1:0:2' }],
    ]);
    await broker.handleCallback(CHAT, 'q:p1:0:1');
    await broker.handleCallback(CHAT, 'q:p1:0:done');

    await expect(result).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which features?': 'Billing, Search' } },
    });
  });

  it('refuses Xong with nothing selected', async () => {
    void ask({ questions: [multiQuestion] });
    await tick();
    expect(await broker.handleCallback(CHAT, 'q:p1:0:done')).toEqual({
      alert: 'Chọn ít nhất 1 lựa chọn hoặc bấm Khác',
    });
    expect(broker.hasPending(CHAT)).toBe(true);
  });

  it('uses free text after Khác', async () => {
    const result = ask({ questions: [singleQuestion] });
    await tick();
    await broker.handleCallback(CHAT, 'q:p1:0:other');
    expect(ui.notices).toEqual([{ chatId: CHAT, text: 'Gõ câu trả lời của bạn' }]);
    expect(await broker.consumeText(CHAT, 'MySQL')).toBe(true);
    await expect(result).resolves.toMatchObject({ updatedInput: { answers: { 'Which <DB>?': 'MySQL' } } });
  });

  it('takes a plain text message as the answer without tapping Khác', async () => {
    const result = ask({ questions: [singleQuestion] });
    await tick();
    expect(await broker.consumeText(CHAT, 'SQLite')).toBe(true);
    await expect(result).resolves.toMatchObject({ updatedInput: { answers: { 'Which <DB>?': 'SQLite' } } });
  });

  it('asks multiple questions one at a time', async () => {
    const result = ask({ questions: [singleQuestion, multiQuestion] });
    await tick();
    expect(ui.sent).toHaveLength(1);

    await broker.handleCallback(CHAT, 'q:p1:0:1');
    await tick();
    expect(ui.sent).toHaveLength(2);
    expect(ui.sent[1]?.keyboard[0]).toEqual([{ text: 'Auth', data: 'q:p1:1:0' }]);

    await broker.handleCallback(CHAT, 'q:p1:1:0');
    await broker.handleCallback(CHAT, 'q:p1:1:done');
    await expect(result).resolves.toMatchObject({
      updatedInput: { answers: { 'Which <DB>?': 'Mongo', 'Which features?': 'Auth' } },
    });
  });

  it('denies invalid input without showing anything', async () => {
    await expect(ask({ questions: [] })).resolves.toEqual({
      behavior: 'deny',
      message: 'Invalid AskUserQuestion input',
    });
    expect(ui.sent).toEqual([]);
  });
});

describe('approvals', () => {
  it('shows the request and allows on ✅', async () => {
    const input = { command: 'rm -rf C:\\x' };
    const result = broker.canUseToolFor(CHAT)('Bash', input, callOptions({
      title: 'Claude wants to run rm',
      decisionReason: 'critical path',
    }));
    await tick();

    expect(ui.sent[0]?.html).toContain('🔐 Claude xin quyền: Claude wants to run rm');
    expect(ui.sent[0]?.html).toContain('critical path');
    expect(ui.sent[0]?.html).toContain('rm -rf C:\\x');
    expect(ui.sent[0]?.keyboard).toEqual([
      [
        { text: '✅ Cho phép', data: 'a:p1:y' },
        { text: '❌ Từ chối', data: 'a:p1:n' },
      ],
    ]);
    expect(await broker.consumeText(CHAT, 'yes')).toBe(false);

    await broker.handleCallback(CHAT, 'a:p1:y');
    await expect(result).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(ui.lastEdit().html).toContain('✅ Đã cho phép');
  });

  it('denies on ❌ and summarizes non-shell input', async () => {
    const result = broker.canUseToolFor(CHAT)('Write', { file_path: 'C:\\a.txt', content: 'x' }, callOptions());
    await tick();
    expect(ui.sent[0]?.html).toContain('🔐 Claude xin quyền: Write');
    expect(ui.sent[0]?.html).toContain('C:\\a.txt');

    await broker.handleCallback(CHAT, 'a:p1:n');
    await expect(result).resolves.toEqual({ behavior: 'deny', message: 'User denied this action via Telegram' });
    expect(ui.lastEdit().html).toContain('❌ Đã từ chối');
  });
});

describe('lifecycle', () => {
  it('denies and marks the prompt expired after the timeout', async () => {
    const result = ask({ questions: [singleQuestion] });
    await tick();
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    await expect(result).resolves.toEqual({
      behavior: 'deny',
      message: 'The user did not respond in time. Do not assume an answer; stop and summarize where you are.',
    });
    expect(ui.lastEdit()).toMatchObject({ html: '⌛ Hết hạn — không có trả lời', keyboard: null });
    expect(broker.hasPending(CHAT)).toBe(false);
  });

  it('denies when the SDK aborts the request', async () => {
    const controller = new AbortController();
    const result = ask({ questions: [singleQuestion] }, CHAT, controller.signal);
    await tick();
    controller.abort();
    await expect(result).resolves.toEqual({ behavior: 'deny', message: 'The turn was cancelled' });
    expect(ui.lastEdit()).toMatchObject({ html: '⏹ Đã huỷ', keyboard: null });
  });

  it('answers stale, malformed or foreign callbacks with an expiry alert', async () => {
    void ask({ questions: [singleQuestion] });
    await tick();
    const expired = { alert: 'Câu hỏi này đã hết hạn' };
    expect(await broker.handleCallback(CHAT, 'q:zzz:0:0')).toEqual(expired);
    expect(await broker.handleCallback(CHAT, 'q:p1')).toEqual(expired);
    expect(await broker.handleCallback(8, 'q:p1:0:0')).toEqual(expired);
    expect(await broker.handleCallback(CHAT, 'q:p1:0:9')).toEqual(expired);
    expect(broker.hasPending(CHAT)).toBe(true);
  });

  it('shows a second prompt only after the first is resolved', async () => {
    const first = broker.canUseToolFor(CHAT)('Bash', { command: 'x' }, callOptions());
    const second = ask({ questions: [singleQuestion] });
    await tick();
    expect(ui.sent).toHaveLength(1);

    await broker.handleCallback(CHAT, 'a:p1:y');
    await first;
    await tick();
    expect(ui.sent).toHaveLength(2);
    await broker.handleCallback(CHAT, 'q:p2:0:0');
    await expect(second).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('cancelPending resolves the displayed and the waiting prompt', async () => {
    const first = ask({ questions: [singleQuestion] });
    const second = broker.canUseToolFor(CHAT)('Bash', { command: 'x' }, callOptions());
    await tick();

    broker.cancelPending(CHAT);
    const stopped = { behavior: 'deny', message: 'User stopped the turn' };
    await expect(first).resolves.toEqual(stopped);
    await expect(second).resolves.toEqual(stopped);
    expect(ui.sent).toHaveLength(1);
    expect(ui.lastEdit()).toMatchObject({ html: '⏹ Đã huỷ' });
    expect(broker.hasPending(CHAT)).toBe(false);
  });

  it('does not consume text when nothing is pending', async () => {
    expect(await broker.consumeText(CHAT, 'hello')).toBe(false);
  });
});
