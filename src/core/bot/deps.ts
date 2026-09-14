import type { Logger } from 'pino';
import type { AgentProvider } from '../../providers/types.js';
import type { AllowedUsersSource } from '../config/allowedUsers.js';
import type { PromptBroker } from '../prompts/broker.js';
import type { SessionManager } from '../sessions/manager.js';
import type { StateStore } from '../sessions/store.js';
import type { ProjectPicker } from './projects.js';
import type { TelegramIo } from './telegramIo.js';

export interface BotSettings {
  botToken: string;
  /** Root folder for Telegram downloads; files are grouped by date below it. */
  uploadsDir: string;
  idleTimeoutMs: number;
}

export interface BotDeps {
  settings: BotSettings;
  manager: SessionManager;
  broker: PromptBroker;
  store: StateStore;
  io: TelegramIo;
  provider: AgentProvider;
  users: AllowedUsersSource;
  projects: ProjectPicker;
  logger: Logger;
  now: () => number;
  pathExists: (path: string) => Promise<boolean>;
}
