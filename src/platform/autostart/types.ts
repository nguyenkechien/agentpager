import type { AppPaths } from '../paths.js';

/** The command autostart launches: `<nodePath> <cliPath> daemon`, captured when autostart is turned on. */
export interface AutostartTarget {
  nodePath: string;
  cliPath: string;
  workingDir: string;
}

export interface AutostartStatus {
  enabled: boolean;
  target: AutostartTarget | null;
  /** Human-readable problems in Vietnamese, e.g. a Node upgrade that removed the captured node path. */
  problems: string[];
}

export interface Autostart {
  /** Resolves with the messages to show the user. */
  enable(target: AutostartTarget): Promise<string[]>;
  disable(): Promise<string[]>;
  status(): Promise<AutostartStatus>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  /** Resolves with the exit code; rejects only when the command cannot be started at all. */
  run(command: string, args: string[]): Promise<CommandResult>;
}

export interface AutostartDeps {
  platform: NodeJS.Platform;
  homedir: string;
  uid: number;
  paths: AppPaths;
  runner: CommandRunner;
  writeFile: (path: string, text: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  /** Resolves null when the file does not exist. */
  readFile: (path: string) => Promise<string | null>;
  makeDir: (path: string) => Promise<void>;
}

export const TASK_NAME = 'agentpager';
export const LEGACY_TASK_NAME = 'claude-pager';
export const LAUNCH_AGENT_LABEL = 'io.github.nguyenkechien.agentpager';
export const UNSUPPORTED_PLATFORM_MESSAGE = 'Autostart chỉ hỗ trợ Windows và macOS';
