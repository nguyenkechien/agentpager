import { posix, win32 } from 'node:path';
import type { AutostartTarget } from './types.js';

function isAbsolutePath(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path);
}

/** Paths the registered command relies on that no longer exist (e.g. Node upgraded, app moved). */
export async function targetProblems(target: AutostartTarget, exists: (path: string) => Promise<boolean>): Promise<string[]> {
  const problems: string[] = [];
  for (const path of [target.command, ...target.args.filter(isAbsolutePath)]) {
    if (!(await exists(path))) problems.push(`No longer exists: ${path}`);
  }
  return problems;
}
