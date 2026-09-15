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
    expect(submitReply({ kind: 'queued', position: 3 }, NOW)).toBe('📥 Queued (position 3)');
    expect(submitReply({ kind: 'queue_full' }, NOW)).toBe('⚠️ The queue is full (10). Use /stop or wait.');
  });

  it('explains that a plan limit blocks the message', () => {
    const now = new Date(2026, 8, 14, 12, 0).getTime();
    expect(
      submitReply({ kind: 'limit_blocked', label: '5-hour', resetsAtMs: new Date(2026, 8, 14, 13, 30).getTime() }, now),
    ).toBe('⛔ Still over the 5-hour limit · resets at 13:30 (in 1 hour 30 minutes). Your message was not sent to the agent.');
  });
});

describe('helpText', () => {
  it('names the agent and lists every command for a full-featured provider', () => {
    const text = helpText(CWD, 60, { displayName: 'Claude Code', capabilities: FULL_CAPABILITIES });
    expect(text.split('\n')[0]).toBe('🤖 agentpager — control Claude Code on your computer remotely.');
    expect(text).toContain('/history — past sessions (/history all: every session in the project)');
    expect(text).toContain('/usage — plan limit usage (5-hour / 7-day)');
    expect(text).toContain('Sessions end after 60 minutes of inactivity.');
  });

  it('hides commands the provider cannot support', () => {
    const text = helpText(CWD, 60, {
      displayName: 'Other',
      capabilities: { ...FULL_CAPABILITIES, sessionListing: false, usage: 'none' },
    });
    expect(text).toContain('/history — past sessions\n');
    expect(text).not.toContain('/usage');
  });
});

describe('historyView', () => {
  it('shows an empty bot history with a toggle', async () => {
    await expect(historyView('bot', CHAT, 0, { store, source, now: () => NOW })).resolves.toEqual({
      text: '🗂 Sessions started from the bot (page 1)\n\nNo sessions started from the bot yet.',
      keyboard: [[{ text: '📂 All sessions in the project', data: 'h:a:0' }]],
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
      '🗂 Sessions started from the bot (page 1)',
      '',
      '1. A very long title that definitely exceeds the forty character button limit · app · 1 hour ago',
    ]);
    expect(view.keyboard[0]).toEqual([{ text: '▶️ 1. A very long title that definitely excee…', data: 'r:id-11' }]);
    expect(view.keyboard).toHaveLength(12);
    expect(view.keyboard.at(-2)).toEqual([{ text: '➡️', data: 'h:b:1' }]);
    expect(view.keyboard.at(-1)).toEqual([{ text: '📂 All sessions in the project', data: 'h:a:0' }]);

    const second = await historyView('bot', CHAT, 1, { store, source, now: () => NOW });
    expect(second.text).toContain('11. t1 · app');
    expect(second.keyboard.at(-2)).toEqual([{ text: '⬅️', data: 'h:b:0' }]);
  });

  it('lists all project sessions with markers', async () => {
    sessions = [{ sessionId: 'x1', title: 'desktop work', lastModified: NOW - 60_000, cwd: CWD }];
    const view = await historyView('all', CHAT, 0, { store, source, now: () => NOW });
    expect(view.text).toBe(
      '🗂 All sessions in app (page 1)\n\n1. ⚠️ desktop work · app · 1 minute ago (may be open elsewhere)',
    );
    expect(view.keyboard.at(-1)).toEqual([{ text: '🤖 Sessions started from the bot', data: 'h:b:0' }]);
  });

  it('drops the toggle and refuses all mode without session listing', async () => {
    await expect(historyView('bot', CHAT, 0, { store, source: undefined, now: () => NOW })).resolves.toEqual({
      text: '🗂 Sessions started from the bot (page 1)\n\nNo sessions started from the bot yet.',
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
    expect(view.text).toBe('📁 Current project: D:\\Projects\\b\nChoose a project:');
    expect(view.keyboard).toEqual([
      [
        { text: 'Projects (root)', data: 'p:abc:0' },
        { text: 'a', data: 'p:abc:1' },
      ],
      [{ text: '✅ b', data: 'p:abc:2' }],
    ]);
  });
});

describe('modelView', () => {
  it('marks the current model and effort from the provider catalog', () => {
    const view = modelView(CLAUDE_CODE_MODELS, CLAUDE_CODE_EFFORTS, 'sonnet', null);
    expect(view.text).toBe('🤖 Model: Sonnet · Effort: default\nApplies from your next message.');
    expect(view.keyboard).toEqual([
      [
        { text: 'Opus', data: 'm:opus' },
        { text: '✅ Sonnet', data: 'm:sonnet' },
        { text: 'Haiku', data: 'm:haiku' },
        { text: 'default', data: 'm:default' },
      ],
      [
        { text: 'low', data: 'e:low' },
        { text: 'medium', data: 'e:medium' },
        { text: 'high', data: 'e:high' },
      ],
      [
        { text: 'xhigh', data: 'e:xhigh' },
        { text: 'max', data: 'e:max' },
        { text: '✅ default', data: 'e:default' },
      ],
    ]);
  });

  it('treats values the provider does not offer as the default', () => {
    const view = modelView(CLAUDE_CODE_MODELS, ['low'], 'gpt-5', 'max');
    expect(view.text).toBe('🤖 Model: default · Effort: default\nApplies from your next message.');
    expect(view.keyboard[1]).toEqual([
      { text: 'low', data: 'e:low' },
      { text: '✅ default', data: 'e:default' },
    ]);
  });
});

describe('resumeReply', () => {
  const exists = (): Promise<boolean> => Promise.resolve(true);

  it('resumes a resolved session', async () => {
    sessions = [{ sessionId: 'abcdef12-0000', title: 'old task', lastModified: 1, cwd: 'D:\\Projects\\trader' }];
    const manager = { resume: vi.fn(() => 'ok' as const) };
    await expect(resumeReply('abcdef12-0000', CHAT, { store, source, manager, pathExists: exists })).resolves.toBe(
      '▶️ Resumed: old task (trader)',
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
    await expect(resumeReply('abc', CHAT, deps)).resolves.toBe('The ID needs at least 8 characters.');
    await expect(resumeReply('zzzzzzzz', CHAT, deps)).resolves.toBe('Session not found.');

    sessions = [
      { sessionId: 'dup00000-1', title: 'a', lastModified: 2, cwd: CWD },
      { sessionId: 'dup00000-2', title: 'b', lastModified: 1, cwd: CWD },
    ];
    await expect(resumeReply('dup00000', CHAT, deps)).resolves.toBe(
      'Several sessions match:\ndup00000-1\ndup00000-2\nType more characters of the ID.',
    );
    await expect(resumeReply('dup00000-1', CHAT, deps)).resolves.toBe('The agent is busy — /stop it first.');
    await expect(resumeReply('dup00000-1', CHAT, { ...deps, pathExists: () => Promise.resolve(false) })).resolves.toBe(
      `The session's folder no longer exists: ${CWD}`,
    );
  });
});
