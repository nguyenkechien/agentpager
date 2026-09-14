import type { SessionSource } from '../../providers/types.js';
import type { StateStore } from './store.js';

export const HISTORY_PAGE_SIZE = 10;
export const RECENTLY_MODIFIED_MS = 5 * 60 * 1000;
export const MIN_PREFIX_LENGTH = 8;
const PREFIX_SCAN_LIMIT = 200;

export interface HistoryEntry {
  sessionId: string;
  title: string;
  cwd: string | null;
  lastActiveAt: number;
  botOwned: boolean;
  maybeOpenElsewhere: boolean;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  page: number;
  hasMore: boolean;
}

export type ResumeTarget =
  | { kind: 'ok'; sessionId: string; cwd: string; title: string }
  | { kind: 'ambiguous'; sessionIds: string[] }
  | { kind: 'not_found' }
  | { kind: 'cwd_missing'; cwd: string }
  | { kind: 'too_short' };

export async function listHistory(
  mode: 'bot' | 'all',
  chatId: number,
  page: number,
  deps: { store: StateStore; source: SessionSource | undefined; now: () => number },
): Promise<HistoryPage> {
  const offset = page * HISTORY_PAGE_SIZE;

  if (mode === 'bot') {
    const records = deps.store.sessionsForChat(chatId);
    return {
      page,
      hasMore: records.length > offset + HISTORY_PAGE_SIZE,
      entries: records.slice(offset, offset + HISTORY_PAGE_SIZE).map((record) => ({
        sessionId: record.sessionId,
        title: record.title,
        cwd: record.cwd,
        lastActiveAt: record.lastActiveAt,
        botOwned: true,
        maybeOpenElsewhere: false,
      })),
    };
  }

  if (!deps.source) return { page, hasMore: false, entries: [] };
  const chat = deps.store.getChat(chatId);
  const infos = await deps.source.list({ dir: chat.cwd, limit: HISTORY_PAGE_SIZE + 1, offset });
  const now = deps.now();
  return {
    page,
    hasMore: infos.length > HISTORY_PAGE_SIZE,
    entries: infos.slice(0, HISTORY_PAGE_SIZE).map((info) => ({
      sessionId: info.sessionId,
      title: info.title,
      cwd: info.cwd,
      lastActiveAt: info.lastModified,
      botOwned: deps.store.findSession(info.sessionId) !== undefined,
      maybeOpenElsewhere: now - info.lastModified < RECENTLY_MODIFIED_MS && info.sessionId !== chat.activeSessionId,
    })),
  };
}

/** Without a provider session source only sessions from the bot registry can be resumed. */
export async function resolveResumeTarget(
  arg: string,
  chatId: number,
  deps: { store: StateStore; source: SessionSource | undefined; pathExists: (path: string) => Promise<boolean> },
): Promise<ResumeTarget> {
  const wanted = arg.trim().toLowerCase();
  if (wanted.length < MIN_PREFIX_LENGTH) return { kind: 'too_short' };

  const chat = deps.store.getChat(chatId);
  const listed = deps.source ? await deps.source.list({ dir: chat.cwd, limit: PREFIX_SCAN_LIMIT, offset: 0 }) : [];
  const candidates = [
    ...new Set([
      ...deps.store.sessionsForChat(chatId).map((record) => record.sessionId),
      ...listed.map((info) => info.sessionId),
    ]),
  ];
  const matches = candidates.filter((sessionId) => sessionId.toLowerCase().startsWith(wanted));
  if (matches.length > 1) return { kind: 'ambiguous', sessionIds: matches };

  const sessionId = matches[0] ?? wanted;
  let resolvedId: string;
  let cwd: string;
  let title: string;
  if (deps.source) {
    const info = await deps.source.info(sessionId);
    if (!info) return { kind: 'not_found' };
    const record = deps.store.findSession(info.sessionId);
    resolvedId = info.sessionId;
    cwd = record?.cwd ?? info.cwd ?? chat.cwd;
    title = record?.title ?? info.title;
  } else {
    const record = deps.store.findSession(sessionId);
    if (!record) return { kind: 'not_found' };
    resolvedId = record.sessionId;
    cwd = record.cwd;
    title = record.title;
  }

  if (!(await deps.pathExists(cwd))) return { kind: 'cwd_missing', cwd };
  return { kind: 'ok', sessionId: resolvedId, cwd, title };
}
