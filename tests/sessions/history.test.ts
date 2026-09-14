import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { listHistory, resolveResumeTarget, type SessionSource } from '../../src/sessions/history.js';
import { StateStore } from '../../src/sessions/store.js';

const CHAT = 7;
const CWD = 'D:\\Projects\\app';
const NOW = 10_000_000;

class FakeSource implements SessionSource {
  constructor(public sessions: SDKSessionInfo[]) {}

  list(options: { dir: string; limit: number; offset: number }): Promise<SDKSessionInfo[]> {
    return Promise.resolve(
      this.sessions
        .filter((session) => session.cwd === options.dir)
        .sort((a, b) => b.lastModified - a.lastModified)
        .slice(options.offset, options.offset + options.limit),
    );
  }

  info(sessionId: string): Promise<SDKSessionInfo | undefined> {
    return Promise.resolve(this.sessions.find((session) => session.sessionId === sessionId));
  }
}

let store: StateStore;
let source: FakeSource;

beforeEach(async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pager-history-')), 'state.json');
  store = (await StateStore.open(file, { cwd: CWD, model: null, effort: null }, () => NOW)).store;
  source = new FakeSource([]);
});

describe('listHistory bot mode', () => {
  beforeEach(() => {
    for (let i = 0; i < 25; i += 1) {
      store.upsertSession({
        sessionId: `bot-${String(i).padStart(2, '0')}`,
        chatId: CHAT,
        cwd: CWD,
        title: `title ${i}`,
        createdAt: i,
        lastActiveAt: i,
      });
    }
  });

  it('pages registry records newest first', async () => {
    const first = await listHistory('bot', CHAT, 0, { store, source, now: () => NOW });
    expect(first.hasMore).toBe(true);
    expect(first.entries.map((entry) => entry.sessionId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `bot-${String(24 - i).padStart(2, '0')}`),
    );
    expect(first.entries[0]).toEqual({
      sessionId: 'bot-24',
      title: 'title 24',
      cwd: CWD,
      lastActiveAt: 24,
      botOwned: true,
      maybeOpenElsewhere: false,
    });

    const last = await listHistory('bot', CHAT, 2, { store, source, now: () => NOW });
    expect(last.page).toBe(2);
    expect(last.hasMore).toBe(false);
    expect(last.entries).toHaveLength(5);
  });
});

describe('listHistory all mode', () => {
  it('lists every session of the current project with markers', async () => {
    store.upsertSession({ sessionId: 'owned', chatId: CHAT, cwd: CWD, title: 'bot title', createdAt: 1, lastActiveAt: 1 });
    source.sessions = [
      { sessionId: 'owned', summary: 'summary owned', lastModified: NOW - 3_600_000, cwd: CWD },
      { sessionId: 'recent', summary: 'summary recent', customTitle: 'Custom', lastModified: NOW - 60_000, cwd: CWD },
      { sessionId: 'old', summary: 'summary old', lastModified: NOW - 10 * 60_000, cwd: CWD },
      { sessionId: 'elsewhere', summary: 'other project', lastModified: NOW, cwd: 'D:\\Projects\\other' },
    ];

    const page = await listHistory('all', CHAT, 0, { store, source, now: () => NOW });
    expect(page.hasMore).toBe(false);
    expect(page.entries).toEqual([
      { sessionId: 'recent', title: 'Custom', cwd: CWD, lastActiveAt: NOW - 60_000, botOwned: false, maybeOpenElsewhere: true },
      { sessionId: 'old', title: 'summary old', cwd: CWD, lastActiveAt: NOW - 600_000, botOwned: false, maybeOpenElsewhere: false },
      { sessionId: 'owned', title: 'summary owned', cwd: CWD, lastActiveAt: NOW - 3_600_000, botOwned: true, maybeOpenElsewhere: false },
    ]);
  });

  it('does not flag the chat own active session and detects more pages', async () => {
    store.updateChat(CHAT, { activeSessionId: 's-0' });
    source.sessions = Array.from({ length: 11 }, (_, i) => ({
      sessionId: `s-${i}`,
      summary: `s ${i}`,
      lastModified: NOW - i,
      cwd: CWD,
    }));
    const page = await listHistory('all', CHAT, 0, { store, source, now: () => NOW });
    expect(page.entries).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    expect(page.entries[0]?.maybeOpenElsewhere).toBe(false);
    expect(page.entries[1]?.maybeOpenElsewhere).toBe(true);
  });
});

describe('resolveResumeTarget', () => {
  const exists = (): Promise<boolean> => Promise.resolve(true);

  beforeEach(() => {
    store.upsertSession({
      sessionId: 'aaaaaaaa-1111-0000-0000-000000000000',
      chatId: CHAT,
      cwd: 'D:\\Projects\\trader',
      title: 'registry title',
      createdAt: 1,
      lastActiveAt: 1,
    });
    source.sessions = [
      { sessionId: 'aaaaaaaa-1111-0000-0000-000000000000', summary: 'sdk summary', lastModified: 1, cwd: 'D:\\Projects\\trader' },
      { sessionId: 'bbbbbbbb-2222-0000-0000-000000000000', summary: 'b one', lastModified: 2, cwd: CWD },
      { sessionId: 'bbbbbbbb-3333-0000-0000-000000000000', summary: 'b two', lastModified: 3, cwd: CWD },
      { sessionId: 'cccccccc-4444-0000-0000-000000000000', summary: 'far away', lastModified: 4, cwd: 'E:\\work' },
    ];
  });

  it('requires at least 8 characters', async () => {
    await expect(resolveResumeTarget('aaaa', CHAT, { store, source, pathExists: exists })).resolves.toEqual({
      kind: 'too_short',
    });
  });

  it('resolves a unique registry prefix using the registry cwd and title', async () => {
    await expect(resolveResumeTarget('aaaaaaaa', CHAT, { store, source, pathExists: exists })).resolves.toEqual({
      kind: 'ok',
      sessionId: 'aaaaaaaa-1111-0000-0000-000000000000',
      cwd: 'D:\\Projects\\trader',
      title: 'registry title',
    });
  });

  it('reports ambiguous prefixes', async () => {
    await expect(resolveResumeTarget('bbbbbbbb', CHAT, { store, source, pathExists: exists })).resolves.toEqual({
      kind: 'ambiguous',
      sessionIds: ['bbbbbbbb-3333-0000-0000-000000000000', 'bbbbbbbb-2222-0000-0000-000000000000'],
    });
  });

  it('resolves a full id outside the current project through session info', async () => {
    await expect(
      resolveResumeTarget('cccccccc-4444-0000-0000-000000000000', CHAT, { store, source, pathExists: exists }),
    ).resolves.toEqual({
      kind: 'ok',
      sessionId: 'cccccccc-4444-0000-0000-000000000000',
      cwd: 'E:\\work',
      title: 'far away',
    });
  });

  it('reports unknown ids and sessions whose files are gone', async () => {
    await expect(resolveResumeTarget('dddddddd', CHAT, { store, source, pathExists: exists })).resolves.toEqual({
      kind: 'not_found',
    });
    source.sessions = source.sessions.filter((session) => !session.sessionId.startsWith('aaaa'));
    await expect(resolveResumeTarget('aaaaaaaa', CHAT, { store, source, pathExists: exists })).resolves.toEqual({
      kind: 'not_found',
    });
  });

  it('reports a missing working directory', async () => {
    await expect(
      resolveResumeTarget('aaaaaaaa', CHAT, { store, source, pathExists: () => Promise.resolve(false) }),
    ).resolves.toEqual({ kind: 'cwd_missing', cwd: 'D:\\Projects\\trader' });
  });
});
