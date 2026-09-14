import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_CAP_PER_CHAT, StateStore, type SessionRecord } from '../../../src/core/sessions/store.js';

const defaults = { cwd: 'D:\\Projects', model: null, effort: null } as const;
let dir: string;
let file: string;
let clock: number;
const now = (): number => clock;

function record(chatId: number, index: number): SessionRecord {
  return {
    sessionId: `s-${chatId}-${index}`,
    chatId,
    cwd: 'D:\\Projects\\x',
    title: `title ${index}`,
    createdAt: index,
    lastActiveAt: index,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pager-store-'));
  file = join(dir, 'state.json');
  clock = 1_000;
});

describe('StateStore', () => {
  it('starts empty when the file does not exist', async () => {
    const { store, quarantinedPath } = await StateStore.open(file, defaults, now);
    expect(quarantinedPath).toBeNull();
    expect(store.allChats()).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('returns a default chat state without persisting it', async () => {
    const { store } = await StateStore.open(file, defaults, now);
    expect(store.getChat(7)).toEqual({
      chatId: 7,
      cwd: 'D:\\Projects',
      activeSessionId: null,
      lastActivityAt: 1_000,
      model: null,
      effort: null,
      runningSince: null,
      lastTurnCostUsd: null,
      limitBlock: null,
      limitWarnings: [],
    });
    await store.flush();
    expect(existsSync(file)).toBe(false);
  });

  it('quarantines a state file whose chats miss required fields', async () => {
    const incompleteChat = {
      chatId: 7,
      cwd: 'D:\\Projects',
      activeSessionId: 's1',
      lastActivityAt: 5,
      model: null,
      effort: null,
      runningSince: null,
      lastTurnCostUsd: null,
    };
    writeFileSync(file, JSON.stringify({ version: 1, chats: [incompleteChat], sessions: [] }));
    const { store, quarantinedPath } = await StateStore.open(file, defaults, now);
    expect(quarantinedPath).toBe(`${file}.corrupt-1000`);
    expect(existsSync(file)).toBe(false);
    expect(store.allChats()).toEqual([]);
  });

  it('persists updates and reloads them', async () => {
    const { store } = await StateStore.open(file, defaults, now);
    store.updateChat(7, { activeSessionId: 'abc', model: 'opus' });
    store.upsertSession(record(7, 1));
    await store.flush();

    const reopened = (await StateStore.open(file, defaults, now)).store;
    expect(reopened.getChat(7).activeSessionId).toBe('abc');
    expect(reopened.getChat(7).model).toBe('opus');
    expect(reopened.findSession('s-7-1')?.title).toBe('title 1');
  });

  it('serializes rapid writes and leaves no temp file', async () => {
    const { store } = await StateStore.open(file, defaults, now);
    for (let i = 0; i < 5; i += 1) store.updateChat(7, { lastActivityAt: i });
    await store.flush();
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { chats: { lastActivityAt: number }[] };
    expect(saved.chats[0]?.lastActivityAt).toBe(4);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('retries a failed write on flush and clears the error once it succeeds', async () => {
    const errors: Error[] = [];
    const { store } = await StateStore.open(file, defaults, now, (error) => errors.push(error));
    // A directory where the temp file should go makes the write fail.
    mkdirSync(`${file}.tmp`);
    store.updateChat(7, { activeSessionId: 'x' });
    await expect(store.flush()).rejects.toThrow();
    expect(errors).toHaveLength(1);

    rmSync(`${file}.tmp`, { recursive: true });
    await store.flush();
    await store.flush();
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { chats: { activeSessionId: string }[] };
    expect(saved.chats[0]?.activeSessionId).toBe('x');
  });

  it.each([
    ['unparseable JSON', '{nope'],
    ['schema-invalid JSON', JSON.stringify({ version: 1, chats: [{ chatId: 'x' }], sessions: [] })],
  ])('quarantines %s and starts empty', async (_label, content) => {
    writeFileSync(file, content);
    const { store, quarantinedPath } = await StateStore.open(file, defaults, now);
    expect(quarantinedPath).not.toBeNull();
    expect(quarantinedPath).toMatch(/state\.json\.corrupt-\d+$/);
    expect(existsSync(quarantinedPath ?? '')).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(store.allChats()).toEqual([]);
  });

  it('updates an existing session record in place', async () => {
    const { store } = await StateStore.open(file, defaults, now);
    store.upsertSession(record(7, 1));
    store.upsertSession({ ...record(7, 1), lastActiveAt: 99 });
    expect(store.sessionsForChat(7)).toHaveLength(1);
    expect(store.findSession('s-7-1')?.lastActiveAt).toBe(99);
  });

  it('orders sessions newest first and isolates chats', async () => {
    const { store } = await StateStore.open(file, defaults, now);
    store.upsertSession(record(7, 1));
    store.upsertSession(record(7, 3));
    store.upsertSession(record(7, 2));
    store.upsertSession(record(8, 5));
    expect(store.sessionsForChat(7).map((s) => s.sessionId)).toEqual(['s-7-3', 's-7-2', 's-7-1']);
    expect(store.sessionsForChat(8).map((s) => s.sessionId)).toEqual(['s-8-5']);
  });

  it('caps the registry per chat by dropping the oldest records', async () => {
    const { store } = await StateStore.open(file, defaults, now);
    for (let i = 0; i <= REGISTRY_CAP_PER_CHAT; i += 1) store.upsertSession(record(7, i));
    store.upsertSession(record(8, 0));
    const sessions = store.sessionsForChat(7);
    expect(sessions).toHaveLength(REGISTRY_CAP_PER_CHAT);
    expect(store.findSession('s-7-0')).toBeUndefined();
    expect(store.findSession('s-8-0')).toBeDefined();
  });
});
