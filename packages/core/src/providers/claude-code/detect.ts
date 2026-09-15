import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { findOnPath } from '../../platform/which.js';
import { pathExists } from '../../util/fs.js';
import type { Detection, ProviderSettings } from '../types.js';

const VERSION_TIMEOUT_MS = 10_000;
export const BUNDLED_BINARY_PROBLEM =
  'Claude Code CLI not found; using the one bundled with the SDK — sign in to Claude first (run "claude" once).';

export interface DetectDeps {
  platform: NodeJS.Platform;
  homedir: string;
  pathEnv: string;
  pathExt: string;
  exists: (path: string) => Promise<boolean>;
  runVersion: (executable: string) => Promise<string | null>;
}

export function commonClaudePaths(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') return [win32.join(home, '.local', 'bin', 'claude.exe')];
  return [posix.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
}

export async function detectClaudeCode(settings: ProviderSettings, deps: DetectDeps): Promise<Detection> {
  if (settings.executable) {
    if (!(await deps.exists(settings.executable))) {
      return { executable: null, version: null, problems: [`Configured claude file not found: ${settings.executable}`] };
    }
    return { executable: settings.executable, version: await deps.runVersion(settings.executable), problems: [] };
  }

  const onPath = await findOnPath('claude', {
    platform: deps.platform,
    pathEnv: deps.pathEnv,
    pathExt: deps.pathExt,
    exists: deps.exists,
  });
  const candidates = onPath ? [onPath] : commonClaudePaths(deps.platform, deps.homedir);
  for (const candidate of candidates) {
    if (await deps.exists(candidate)) {
      return { executable: candidate, version: await deps.runVersion(candidate), problems: [] };
    }
  }
  return { executable: null, version: null, problems: [BUNDLED_BINARY_PROBLEM] };
}

export function runClaudeVersion(executable: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(executable, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      // The version is informational only; an unreadable version is reported as unknown.
      if (error) {
        resolve(null);
        return;
      }
      const firstLine = stdout.trim().split(/\r?\n/)[0];
      resolve(firstLine && firstLine.length > 0 ? firstLine : null);
    });
  });
}

export function defaultDetectDeps(): DetectDeps {
  return {
    platform: process.platform,
    homedir: homedir(),
    pathEnv: process.env.PATH ?? process.env.Path ?? '',
    pathExt: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    exists: pathExists,
    runVersion: runClaudeVersion,
  };
}
