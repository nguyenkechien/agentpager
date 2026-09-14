import type { Logger } from 'pino';
import type { PromptBroker } from '../claude/prompts.js';
import type { AppConfig } from '../config.js';
import type { SessionSource } from '../sessions/history.js';
import type { SessionManager } from '../sessions/manager.js';
import type { StateStore } from '../sessions/store.js';
import type { ProjectPicker } from './projects.js';
import type { TelegramIo } from './telegramIo.js';

export interface BotDeps {
  config: AppConfig;
  manager: SessionManager;
  broker: PromptBroker;
  store: StateStore;
  io: TelegramIo;
  source: SessionSource;
  projects: ProjectPicker;
  logger: Logger;
  now: () => number;
  pathExists: (path: string) => Promise<boolean>;
}
