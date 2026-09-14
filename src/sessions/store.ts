import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { EFFORTS, MODEL_ALIASES, type Effort, type ModelAlias } from '../config.js';

export interface ChatState {
  chatId: number;
  cwd: string;
  activeSessionId: string | null;
  lastActivityAt: number;
  model: ModelAlias | null;
  effort: Effort | null;
  runningSince: number | null;
  lastTurnCostUsd: number | null;
}

export interface SessionRecord {
  sessionId: string;
  chatId: number;
  cwd: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface ChatDefaults {
  cwd: string;
  model: ModelAlias | null;
  effort: Effort | null;
}

export const REGISTRY_CAP_PER_CHAT = 200;

const chatSchema = z.object({
  chatId: z.number().int(),
  cwd: z.string(),
  activeSessionId: z.string().nullable(),
  lastActivityAt: z.number(),
  model: z.enum(MODEL_ALIASES as [ModelAlias, ...ModelAlias[]]).nullable(),
  effort: z.enum(EFFORTS as [Effort, ...Effort[]]).nullable(),
  runningSince: z.number().nullable(),
  lastTurnCostUsd: z.number().nullable(),
});

const sessionSchema = z.object({
  sessionId: z.string().min(1),
  chatId: z.number().int(),
  cwd: z.string(),
  title: z.string(),
  createdAt: z.number(),
  lastActiveAt: z.number(),
});

const stateSchema = z.object({
  version: z.literal(1),
  chats: z.array(chatSchema),
  sessions: z.array(sessionSchema),
});

type PersistedState = z.infer<typeof stateSchema>;

function parseState(raw: string): PersistedState | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // Unparseable content is reported to the caller as a quarantined file.
    return null;
  }
  const parsed = stateSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export class StateStore {
  private readonly chats = new Map<number, ChatState>();
  private sessions: SessionRecord[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private writeScheduled = false;
  private dirty = false;
  private lastWriteError: Error | null = null;

  private constructor(
    private readonly filePath: string,
    private readonly defaults: ChatDefaults,
    private readonly now: () => number,
    private readonly onWriteError: ((error: Error) => void) | undefined,
  ) {}

  static async open(
    filePath: string,
    defaults: ChatDefaults,
    now: () => number,
    onWriteError?: (error: Error) => void,
  ): Promise<{ store: StateStore; quarantinedPath: string | null }> {
    const store = new StateStore(filePath, defaults, now, onWriteError);
    let raw: string | null = null;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    let quarantinedPath: string | null = null;
    if (raw !== null) {
      const state = parseState(raw);
      if (state) {
        for (const chat of state.chats) store.chats.set(chat.chatId, chat);
        store.sessions = state.sessions;
      } else {
        quarantinedPath = `${filePath}.corrupt-${now()}`;
        await rename(filePath, quarantinedPath);
      }
    }
    return { store, quarantinedPath };
  }

  getChat(chatId: number): ChatState {
    const existing = this.chats.get(chatId);
    if (existing) return { ...existing };
    return {
      chatId,
      cwd: this.defaults.cwd,
      activeSessionId: null,
      lastActivityAt: this.now(),
      model: this.defaults.model,
      effort: this.defaults.effort,
      runningSince: null,
      lastTurnCostUsd: null,
    };
  }

  allChats(): ChatState[] {
    return [...this.chats.values()].map((chat) => ({ ...chat }));
  }

  updateChat(chatId: number, patch: Partial<Omit<ChatState, 'chatId'>>): ChatState {
    const next: ChatState = { ...this.getChat(chatId), ...patch, chatId };
    this.chats.set(chatId, next);
    this.scheduleWrite();
    return { ...next };
  }

  upsertSession(record: SessionRecord): void {
    const index = this.sessions.findIndex((session) => session.sessionId === record.sessionId);
    if (index >= 0) this.sessions[index] = { ...record };
    else this.sessions.push({ ...record });

    const forChat = this.sessionsForChat(record.chatId);
    if (forChat.length > REGISTRY_CAP_PER_CHAT) {
      const dropped = new Set(forChat.slice(REGISTRY_CAP_PER_CHAT).map((session) => session.sessionId));
      this.sessions = this.sessions.filter((session) => !dropped.has(session.sessionId));
    }
    this.scheduleWrite();
  }

  sessionsForChat(chatId: number): SessionRecord[] {
    return this.sessions
      .filter((session) => session.chatId === chatId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map((session) => ({ ...session }));
  }

  findSession(sessionId: string): SessionRecord | undefined {
    const found = this.sessions.find((session) => session.sessionId === sessionId);
    return found ? { ...found } : undefined;
  }

  /** Waits for pending writes, retrying a previously failed write; rejects while the latest state is not on disk. */
  async flush(): Promise<void> {
    if (this.dirty && !this.writeScheduled) this.scheduleWrite();
    await this.writeChain;
    if (this.lastWriteError) throw this.lastWriteError;
  }

  private scheduleWrite(): void {
    this.dirty = true;
    if (this.writeScheduled) return;
    this.writeScheduled = true;
    this.writeChain = this.writeChain.then(async () => {
      this.writeScheduled = false;
      this.dirty = false;
      try {
        await this.writeSnapshot();
        this.lastWriteError = null;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.dirty = true;
        this.lastWriteError = failure;
        this.onWriteError?.(failure);
      }
    });
  }

  private async writeSnapshot(): Promise<void> {
    const state: PersistedState = { version: 1, chats: [...this.chats.values()], sessions: this.sessions };
    const tmpPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
