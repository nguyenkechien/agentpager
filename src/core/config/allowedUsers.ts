import type { AgentpagerConfig, AllowedUser } from './schema.js';

export type DenyReason = 'not_private' | 'unknown_user' | 'username_paired_to_other_id';

export type AuthDecision =
  | { kind: 'allow' }
  | { kind: 'pair'; username: string; userId: number }
  | { kind: 'deny'; reason: DenyReason };

export interface AuthUpdate {
  fromId: number | undefined;
  username: string | undefined;
  chatType: string | undefined;
}

/**
 * Private chats only. A paired id is trusted regardless of its current username; an unpaired listed username
 * binds the sender's id; a username already bound to another id is refused (the username may have changed hands).
 */
export function decideAuth(update: AuthUpdate, users: readonly AllowedUser[]): AuthDecision {
  if (update.chatType !== 'private') return { kind: 'deny', reason: 'not_private' };
  if (update.fromId === undefined) return { kind: 'deny', reason: 'unknown_user' };
  const fromId = update.fromId;
  if (users.some((user) => user.userId === fromId)) return { kind: 'allow' };

  const username = update.username?.toLowerCase();
  const entry = username ? users.find((user) => user.username === username) : undefined;
  if (!entry || !username) return { kind: 'deny', reason: 'unknown_user' };
  if (entry.userId !== null) return { kind: 'deny', reason: 'username_paired_to_other_id' };
  return { kind: 'pair', username, userId: fromId };
}

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

export interface AllowedUsersStore {
  read(): Promise<AgentpagerConfig>;
  update(mutate: (current: AgentpagerConfig) => AgentpagerConfig): Promise<AgentpagerConfig>;
}

export type AllowedUsersSource = Pick<AllowedUsersRegistry, 'current' | 'pair'>;

/** In-memory view of `allowedUsers`; pairing writes through the config store so the CLI sees it. */
export class AllowedUsersRegistry {
  private users: readonly AllowedUser[] = [];

  constructor(
    private readonly store: AllowedUsersStore,
    private readonly now: () => Date,
  ) {}

  async load(): Promise<void> {
    this.users = (await this.store.read()).allowedUsers;
  }

  current(): readonly AllowedUser[] {
    return this.users;
  }

  async pair(username: string, userId: number): Promise<void> {
    const next = await this.store.update((config) => {
      // The file is re-read here, so a CLI edit made after the last load decides the outcome.
      const entry = config.allowedUsers.find((user) => user.username === username);
      if (!entry) throw new PairingError(`@${username} không còn trong danh sách người dùng`);
      if (entry.userId === userId) return config;
      if (entry.userId !== null) throw new PairingError(`@${username} đã được ghép với user ${entry.userId}`);
      const pairedAt = this.now().toISOString();
      return {
        ...config,
        allowedUsers: config.allowedUsers.map((user) => (user === entry ? { ...user, userId, pairedAt } : user)),
      };
    });
    this.users = next.allowedUsers;
  }

  reload(): Promise<void> {
    return this.load();
  }
}
