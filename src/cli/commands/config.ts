import { ConfigError, isLogLevel, maskToken, type AgentpagerConfig } from '../../core/config/schema.js';
import type { Command } from '../types.js';
import { printRestartHintIfRunning } from './daemonControl.js';

type Setter = (config: AgentpagerConfig, value: string) => AgentpagerConfig;

/** Empty, "null" and "default" clear an optional setting. */
function optional(value: string): string | null {
  return value === '' || value === 'null' || value === 'default' ? null : value;
}

const SETTERS: Record<string, Setter> = {
  'telegram.botToken': (config, value) => ({ ...config, telegram: { botToken: value } }),
  projectsRoot: (config, value) => ({ ...config, projectsRoot: value }),
  idleTimeoutMinutes: (config, value) => {
    if (!/^\d+$/.test(value)) throw new ConfigError([`idleTimeoutMinutes: phải là số nguyên ≥ 1: ${value}`]);
    return { ...config, idleTimeoutMinutes: Number(value) };
  },
  logLevel: (config, value) => {
    if (!isLogLevel(value)) throw new ConfigError([`logLevel: không hợp lệ: ${value}`]);
    return { ...config, logLevel: value };
  },
  'agent.provider': (config, value) => ({ ...config, agent: { ...config.agent, provider: value } }),
  'agent.executable': (config, value) => ({ ...config, agent: { ...config.agent, executable: optional(value) } }),
  'agent.defaultModel': (config, value) => ({ ...config, agent: { ...config.agent, defaultModel: optional(value) } }),
  'agent.defaultEffort': (config, value) => ({ ...config, agent: { ...config.agent, defaultEffort: optional(value) } }),
};

const USAGE = 'Cách dùng: agentpager config path | show | set <khoá> <giá trị>';

export const configCommand: Command = async (args, io, deps) => {
  const [action, key, value] = args.positionals;
  switch (action) {
    case 'path':
      io.out(deps.paths.config);
      return 0;
    case 'show': {
      const config = await deps.configStore.read();
      const masked = { ...config, telegram: { botToken: maskToken(config.telegram.botToken) } };
      for (const line of JSON.stringify(masked, null, 2).split('\n')) io.out(line);
      return 0;
    }
    case 'set': {
      if (key === undefined || value === undefined) {
        io.err(USAGE);
        return 1;
      }
      const setter = SETTERS[key];
      if (!setter) {
        io.err(`Không có khoá "${key}". Các khoá: ${Object.keys(SETTERS).join(', ')}`);
        return 1;
      }
      await deps.configStore.update((config) => setter(config, value));
      io.out(`✅ Đã đặt ${key} = ${key === 'telegram.botToken' ? maskToken(value) : value}`);
      await printRestartHintIfRunning(io, deps);
      return 0;
    }
    default:
      io.err(USAGE);
      return 1;
  }
};
