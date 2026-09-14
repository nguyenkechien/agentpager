import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  helpText,
  historyView,
  modelView,
  NO_SESSION_LISTING_TEXT,
  projectView,
  resumeReply,
  submitReply,
} from '../../../src/core/bot/views.js';
import { StateStore } from '../../../src/core/sessions/store.js';
import { CLAUDE_CODE_EFFORTS, CLAUDE_CODE_MODELS } from '../../../src/providers/claude-code/index.js';
import type { SessionInfo, SessionSource } from '../../../src/providers/types.js';
import { FULL_CAPABILITIES } from '../../support/fakeProvider.js';

const CHAT = 7;
const NOW = 50 * 60 * 60 * 1000;
const CWD = 'D:\\Projects\\app';

let store: StateStore;
let sessions: SessionInfo[];
const source: SessionSource = {
  list: ({ dir, limit, offset }) => Promise.resolve(sessions.filter((s) => s.cwd === dir).slice(offset, offset + limit)),
  info: (id) => Promise.resolve(sessions.find((s) => s.sessionId === id)),
};

beforeEach(async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pager-views-')), 'state.json');
  store = (await StateStore.open(file, { cwd: CWD, model: null, effort: null }, () => NOW)).store;
  sessions = [];
});

describe('submitReply', () => {
  it('describes queue results', () => {
    expect(submitReply({ kind: 'started' }, NOW)).toBeNull();
    expect(submitReply({ kind: 'queued', position: 3 }, NOW)).toBe('📥 Đã xếp hàng (vị trí 3)');
    expect(submitReply({ kind: 'queue_full' }, NOW)).toBe('⚠️ Hàng đợi đầy (10). Dùng /stop hoặc đợi.');
  });

  it('explains that a plan limit blocks the message', () => {
    const now = new Date(2026, 8, 14, 12, 0).getTime();
    expect(
      submitReply({ kind: 'limit_blocked', label: '5 giờ', resetsAtMs: new Date(2026, 8, 14, 13, 30).getTime() }, now),
    ).toBe('⛔ Vẫn đang hết limit 5 giờ · reset lúc 13:30 (còn 1 giờ 30 phút). Tin nhắn chưa được gửi cho agent.');
  });
});

describe('helpText', () => {
  it('names the agent and lists every command for a full-featured provider', () => {
    const text = helpText(CWD, 60, { displayName: 'Claude Code', capabilities: FULL_CAPABILITIES });
    expect(text.split('\n')[0]).toBe('🤖 agentpager — điều khiển Claude Code trên máy từ xa.');
    expect(text).toContain('/history — session cũ (/history all: mọi session của project)');
    expect(text).toContain('/usage — mức dùng limit 5 giờ / 7 ngày');
    expect(text).toContain('Phiên tự kết thúc sau 60 phút không hoạt động.');
  });

  it('hides commands the provider cannot support', () => {
    const text = helpText(CWD, 60, {
      displayName: 'Other',
      capabilities: { ...FULL_CAPABILITIES, sessionListing: false, usage: 'none' },
    });
    expect(text).toContain('/history — session cũ\n');
    expect(text).not.toContain('/usage');
  });
});

describe('historyView', () => {
  it('shows an empty bot history with a toggle', async () => {
    await expect(historyView('bot', CHAT, 0, { store, source, now: () => NOW })).resolves.toEqual({
      text: '🗂 Session tạo từ bot (trang 1)\n\nChưa có session nào tạo từ bot.',
      keyboard: [[{ text: '📂 Mọi session của project', data: 'h:a:0' }]],
    });
  });

  it('numbers entries, adds resume buttons, navigation and toggle', async () => {
    for (let i = 0; i < 12; i += 1) {
      store.upsertSession({
        sessionId: `id-${String(i).padStart(2, '0')}`,
        chatId: CHAT,
        cwd: CWD,
        title: i === 11 ? 'A very long title that definitely exceeds the forty character button limit' : `t${i}`,
        createdAt: i,
        lastActiveAt: NOW - (12 - i) * 60 * 60 * 1000,
      });
    }
    const view = await historyView('bot', CHAT, 0, { store, source, now: () => NOW });
    expect(view.text.split('\n').slice(0, 3)).toEqual([
      '🗂 Session tạo từ bot (trang 1)',
      '',
      '1. A very long title that definitely exceeds the forty character button limit · app · 1 giờ trước',
    ]);
    expect(view.keyboard[0]).toEqual([{ text: '▶️ 1. A very long title that definitely excee…', data: 'r:id-11' }]);
    expect(view.keyboard).toHaveLength(12);
    expect(view.keyboard.at(-2)).toEqual([{ text: '➡️', data: 'h:b:1' }]);
    expect(view.keyboard.at(-1)).toEqual([{ text: '📂 Mọi session của project', data: 'h:a:0' }]);

    const second = await historyView('bot', CHAT, 1, { store, source, now: () => NOW });
    expect(second.text).toContain('11. t1 · app');
    expect(second.keyboard.at(-2)).toEqual([{ text: '⬅️', data: 'h:b:0' }]);
  });

  it('lists all project sessions with markers', async () => {
    sessions = [{ sessionId: 'x1', title: 'desktop work', lastModified: NOW - 60_000, cwd: CWD }];
    const view = await historyView('all', CHAT, 0, { store, source, now: () => NOW });
    expect(view.text).toBe(
      '🗂 Mọi session trong app (trang 1)\n\n1. ⚠️ desktop work · app · 1 phút trước (có thể đang mở ở nơi khác)',
    );
    expect(view.keyboard.at(-1)).toEqual([{ text: '🤖 Session tạo từ bot', data: 'h:b:0' }]);
  });

  it('drops the toggle and refuses all mode without session listing', async () => {
    await expect(historyView('bot', CHAT, 0, { store, source: undefined, now: () => NOW })).resolves.toEqual({
      text: '🗂 Session tạo từ bot (trang 1)\n\nChưa có session nào tạo từ bot.',
      keyboard: [],
    });
    await expect(historyView('all', CHAT, 0, { store, source: undefined, now: () => NOW })).resolves.toEqual({
      text: NO_SESSION_LISTING_TEXT,
      keyboard: [],
    });
  });
});

describe('projectView', () => {
  it('marks the current project and lays out two buttons per row', () => {
    const view = projectView('D:\\Projects\\b', {
      id: 'abc',
      dirs: ['D:\\Projects', 'D:\\Projects\\a', 'D:\\Projects\\b'],
    });
    expect(view.text).toBe('📁 Project hiện tại: D:\\Projects\\b\nChọn project:');
    expect(view.keyboard).toEqual([
      [
        { text: 'Projects (gốc)', data: 'p:abc:0' },
        { text: 'a', data: 'p:abc:1' },
      ],
      [{ text: '✅ b', data: 'p:abc:2' }],
    ]);
  });
});

describe('modelView', () => {
  it('marks the current model and effort from the provider catalog', () => {
    const view = modelView(CLAUDE_CODE_MODELS, CLAUDE_CODE_EFFORTS, 'sonnet', null);
    expect(view.text).toBe('🤖 Model: Sonnet · Effort: mặc định\nÁp dụng từ tin nhắn tiếp theo.');
    expect(view.keyboard).toEqual([
      [
        { text: 'Opus', data: 'm:opus' },
        { text: '✅ Sonnet', data: 'm:sonnet' },
        { text: 'Haiku', data: 'm:haiku' },
        { text: 'mặc định', data: 'm:default' },
      ],
      [
        { text: 'low', data: 'e:low' },
        { text: 'medium', data: 'e:medium' },
        { text: 'high', data: 'e:high' },
      ],
      [
        { text: 'xhigh', data: 'e:xhigh' },
        { text: 'max', data: 'e:max' },
        { text: '✅ mặc định', data: 'e:default' },
      ],
    ]);
  });

  it('treats values the provider does not offer as the default', () => {
    const view = modelView(CLAUDE_CODE_MODELS, ['low'], 'gpt-5', 'max');
    expect(view.text).toBe('🤖 Model: mặc định · Effort: mặc định\nÁp dụng từ tin nhắn tiếp theo.');
    expect(view.keyboard[1]).toEqual([
      { text: 'low', data: 'e:low' },
      { text: '✅ mặc định', data: 'e:default' },
    ]);
  });
});

describe('resumeReply', () => {
  const exists = (): Promise<boolean> => Promise.resolve(true);

  it('resumes a resolved session', async () => {
    sessions = [{ sessionId: 'abcdef12-0000', title: 'old task', lastModified: 1, cwd: 'D:\\Projects\\trader' }];
    const manager = { resume: vi.fn(() => 'ok' as const) };
    await expect(resumeReply('abcdef12-0000', CHAT, { store, source, manager, pathExists: exists })).resolves.toBe(
      '▶️ Đã vào lại: old task (trader)',
    );
    expect(manager.resume).toHaveBeenCalledWith(CHAT, {
      kind: 'ok',
      sessionId: 'abcdef12-0000',
      cwd: 'D:\\Projects\\trader',
      title: 'old task',
    });
  });

  it('explains every failure', async () => {
    const manager = { resume: vi.fn(() => 'busy' as const) };
    const deps = { store, source, manager, pathExists: exists };
    await expect(resumeReply('abc', CHAT, deps)).resolves.toBe('ID cần ít nhất 8 ký tự.');
    await expect(resumeReply('zzzzzzzz', CHAT, deps)).resolves.toBe('Không tìm thấy session này.');

    sessions = [
      { sessionId: 'dup00000-1', title: 'a', lastModified: 2, cwd: CWD },
      { sessionId: 'dup00000-2', title: 'b', lastModified: 1, cwd: CWD },
    ];
    await expect(resumeReply('dup00000', CHAT, deps)).resolves.toBe(
      'Nhiều session khớp:\ndup00000-1\ndup00000-2\nGõ thêm ký tự của ID.',
    );
    await expect(resumeReply('dup00000-1', CHAT, deps)).resolves.toBe('Agent đang chạy, /stop trước.');
    await expect(resumeReply('dup00000-1', CHAT, { ...deps, pathExists: () => Promise.resolve(false) })).resolves.toBe(
      `Thư mục của session không còn tồn tại: ${CWD}`,
    );
  });
});
