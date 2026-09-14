import type { AutostartTarget } from './types.js';

export async function targetProblems(target: AutostartTarget, exists: (path: string) => Promise<boolean>): Promise<string[]> {
  const problems: string[] = [];
  if (!(await exists(target.nodePath))) {
    problems.push(`Không còn tìm thấy Node tại ${target.nodePath} — chạy lại "agentpager autostart on".`);
  }
  if (!(await exists(target.cliPath))) {
    problems.push(`Không còn tìm thấy agentpager tại ${target.cliPath} — chạy lại "agentpager autostart on".`);
  }
  return problems;
}
