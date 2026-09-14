import type { Logger } from 'pino';
import type { AppConfig } from '../../config.js';
import type { AgentProvider } from '../../providers/types.js';
import type { PromptBroker } from '../prompts/broker.js';
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
  provider: AgentProvider;
  projects: ProjectPicker;
  logger: Logger;
  now: () => number;
  pathExists: (path: string) => Promise<boolean>;
}
