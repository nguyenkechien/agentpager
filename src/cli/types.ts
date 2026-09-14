import type { ConfigStore } from '../core/config/store.js';
import type { IpcCommand } from '../daemon/ipc.js';
import type { Autostart } from '../platform/autostart/types.js';
import type { AppPaths, PlatformInfo } from '../platform/paths.js';
import type { ProviderCatalogEntry } from '../providers/types.js';
import type { ParsedArgs } from './args.js';
import type { CliIo } from './io.js';

export interface TelegramLookup {
  getMe: (token: string) => Promise<{ username: string }>;
  /** Null when Telegram does not know the chat. */
  getChat: (token: string, userId: number) => Promise<{ username: string | null } | null>;
}

export interface CliDeps {
  paths: AppPaths;
  platform: PlatformInfo;
  packageRoot: string;
  /** Absolute path of the CLI entry, captured for autostart and the detached daemon. */
  cliPath: string;
  nodePath: string;
  version: string;
  configStore: ConfigStore;
  catalog: readonly ProviderCatalogEntry[];
  autostart: Autostart;
  ipc: (command: IpcCommand) => Promise<unknown>;
  /** Starts `node <cli> daemon` detached with no window. */
  spawnDaemon: () => void;
  runDaemon: (foreground: boolean) => Promise<number>;
  telegram: TelegramLookup;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  readLogTail: (lines: number) => Promise<string[]>;
  /** Calls onLine for every new worker log line; resolves with a function that stops following. */
  followLog: (onLine: (line: string) => void) => Promise<() => void>;
  waitForInterrupt: () => Promise<void>;
  /** The latest fatal worker error the supervisor logged at or after `sinceMs`. */
  lastDaemonFatal: (sinceMs: number) => Promise<string | null>;
  exists: (path: string) => Promise<boolean>;
  /** Resolves null when the file does not exist. */
  readTextFile: (path: string) => Promise<string | null>;
  copyFile: (from: string, to: string) => Promise<void>;
}

export type Command = (args: ParsedArgs, io: CliIo, deps: CliDeps) => Promise<number>;
