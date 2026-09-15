import type { AgentProvider, ModelOption, SessionSource } from '../../providers/types.js';
import type { Button } from '../prompts/broker.js';
import { listHistory, resolveResumeTarget } from '../sessions/history.js';
import type { SessionManager, SubmitResult } from '../sessions/manager.js';
import type { StateStore } from '../sessions/store.js';
import { formatClock, formatDuration, historyLine, plural, projectName } from './format.js';
import type { ProjectSnapshot } from './projects.js';

export const BUSY_TEXT = 'The agent is busy — /stop it first.';
export const STALE_BUTTON_TEXT = 'This button has expired';
export const NO_SESSION_LISTING_TEXT = '📂 This provider cannot list all sessions.';
export const NO_USAGE_TEXT = '📊 This provider does not report usage.';
const BUTTON_TITLE_LENGTH = 40;
const EFFORT_ROW_SIZE = 3;

export interface View {
  text: string;
  keyboard: Button[][];
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function submitReply(result: SubmitResult, nowMs: number): string | null {
  switch (result.kind) {
    case 'started':
      return null;
    case 'queued':
      return `📥 Queued (position ${result.position})`;
    case 'queue_full':
      return '⚠️ The queue is full (10). Use /stop or wait.';
    case 'limit_blocked':
      return `⛔ Still over the ${result.label} limit · resets at ${formatClock(result.resetsAtMs, nowMs)} (in ${formatDuration(result.resetsAtMs - nowMs)}). Your message was not sent to the agent.`;
  }
}

export function helpText(cwd: string, idleMinutes: number, provider: Pick<AgentProvider, 'displayName' | 'capabilities'>): string {
  const { capabilities } = provider;
  return [
    `🤖 agentpager — control ${provider.displayName} on your computer remotely.`,
    'Send messages as usual to work with the agent. Send photos or files for the agent to look at.',
    '',
    `📁 Current project: ${cwd}`,
    '',
    'Commands:',
    '/new — start a new session',
    capabilities.sessionListing ? '/history — past sessions (/history all: every session in the project)' : '/history — past sessions',
    '/resume — resume a session (/resume <id>)',
    '/project — choose a project',
    '/stop — stop the running turn',
    '/status — status',
    '/model — change model / effort',
    ...(capabilities.usage !== 'none' ? ['/usage — plan limit usage (5-hour / 7-day)'] : []),
    '',
    `Sessions end after ${plural(idleMinutes, 'minute')} of inactivity.`,
  ].join('\n');
}

export async function historyView(
  mode: 'bot' | 'all',
  chatId: number,
  page: number,
  deps: { store: StateStore; source: SessionSource | undefined; now: () => number },
): Promise<View> {
  if (mode === 'all' && !deps.source) return { text: NO_SESSION_LISTING_TEXT, keyboard: [] };

  const result = await listHistory(mode, chatId, page, deps);
  const cwd = deps.store.getChat(chatId).cwd;
  const toggle: Button[] = [];
  if (deps.source) {
    toggle.push(
      mode === 'bot'
        ? { text: '📂 All sessions in the project', data: 'h:a:0' }
        : { text: '🤖 Sessions started from the bot', data: 'h:b:0' },
    );
  }
  const toggleRows: Button[][] = toggle.length > 0 ? [toggle] : [];
  const modeKey = mode === 'bot' ? 'b' : 'a';

  const header =
    mode === 'bot' ? `🗂 Sessions started from the bot (page ${page + 1})` : `🗂 All sessions in ${projectName(cwd)} (page ${page + 1})`;
  if (result.entries.length === 0) {
    const empty = mode === 'bot' ? 'No sessions started from the bot yet.' : 'No sessions in this project.';
    const keyboard: Button[][] =
      page > 0 ? [[{ text: '⬅️', data: `h:${modeKey}:${page - 1}` }], ...toggleRows] : toggleRows;
    return { text: `${header}\n\n${empty}`, keyboard };
  }

  const offset = page * 10;
  const now = deps.now();
  const lines = result.entries.map((entry, index) => `${offset + index + 1}. ${historyLine(entry, now, mode)}`);
  const keyboard: Button[][] = result.entries.map((entry, index) => [
    { text: `▶️ ${offset + index + 1}. ${truncate(entry.title, BUTTON_TITLE_LENGTH)}`, data: `r:${entry.sessionId}` },
  ]);

  const navigation: Button[] = [];
  if (page > 0) navigation.push({ text: '⬅️', data: `h:${modeKey}:${page - 1}` });
  if (result.hasMore) navigation.push({ text: '➡️', data: `h:${modeKey}:${page + 1}` });
  if (navigation.length > 0) keyboard.push(navigation);
  keyboard.push(...toggleRows);

  return { text: `${header}\n\n${lines.join('\n')}`, keyboard };
}

export function projectView(cwd: string, snapshot: ProjectSnapshot): View {
  const buttons: Button[] = snapshot.dirs.map((dir, index) => {
    const label = index === 0 ? `${projectName(dir)} (root)` : projectName(dir);
    return { text: `${dir === cwd ? '✅ ' : ''}${label}`, data: `p:${snapshot.id}:${index}` };
  });
  const keyboard: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
  return { text: `📁 Current project: ${cwd}\nChoose a project:`, keyboard };
}

export function modelView(
  models: readonly ModelOption[],
  efforts: readonly string[],
  model: string | null,
  effort: string | null,
): View {
  const mark = (selected: boolean, label: string): string => `${selected ? '✅ ' : ''}${label}`;
  const selectedModel = models.find((option) => option.id === model) ?? null;
  const selectedEffort = effort !== null && efforts.includes(effort) ? effort : null;

  const modelRow: Button[] = [
    ...models.map((option) => ({ text: mark(selectedModel?.id === option.id, option.label), data: `m:${option.id}` })),
    { text: mark(selectedModel === null, 'default'), data: 'm:default' },
  ];
  const effortButtons: Button[] = [
    ...efforts.map((level) => ({ text: mark(selectedEffort === level, level), data: `e:${level}` })),
    { text: mark(selectedEffort === null, 'default'), data: 'e:default' },
  ];
  const keyboard: Button[][] = [modelRow];
  for (let i = 0; i < effortButtons.length; i += EFFORT_ROW_SIZE) keyboard.push(effortButtons.slice(i, i + EFFORT_ROW_SIZE));

  return {
    text: `🤖 Model: ${selectedModel?.label ?? 'default'} · Effort: ${selectedEffort ?? 'default'}\nApplies from your next message.`,
    keyboard,
  };
}

export async function resumeReply(
  arg: string,
  chatId: number,
  deps: {
    store: StateStore;
    source: SessionSource | undefined;
    manager: Pick<SessionManager, 'resume'>;
    pathExists: (path: string) => Promise<boolean>;
  },
): Promise<string> {
  const target = await resolveResumeTarget(arg, chatId, deps);
  switch (target.kind) {
    case 'too_short':
      return 'The ID needs at least 8 characters.';
    case 'not_found':
      return 'Session not found.';
    case 'ambiguous':
      return `Several sessions match:\n${target.sessionIds.join('\n')}\nType more characters of the ID.`;
    case 'cwd_missing':
      return `The session's folder no longer exists: ${target.cwd}`;
    case 'ok':
      if (deps.manager.resume(chatId, target) === 'busy') return BUSY_TEXT;
      return `▶️ Resumed: ${target.title} (${projectName(target.cwd)})`;
  }
}
