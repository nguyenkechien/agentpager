import type { UsageReport } from '../../providers/types.js';
import { formatClock, formatDuration, plural } from '../../util/time.js';
import type { HistoryEntry } from '../sessions/history.js';
import type { StatusSnapshot } from '../sessions/manager.js';

export { formatClock, formatDuration, plural };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BAR_CELLS = 10;

export function relativeTime(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${plural(Math.floor(diff / MINUTE), 'minute')} ago`;
  if (diff < DAY) return `${plural(Math.floor(diff / HOUR), 'hour')} ago`;
  return `${plural(Math.floor(diff / DAY), 'day')} ago`;
}

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

export function historyLine(entry: HistoryEntry, nowMs: number, mode: 'bot' | 'all'): string {
  const markers = `${mode === 'all' && entry.botOwned ? '🤖 ' : ''}${entry.maybeOpenElsewhere ? '⚠️ ' : ''}`;
  const project = entry.cwd ? projectName(entry.cwd) : '?';
  const suffix = entry.maybeOpenElsewhere ? ' (may be open elsewhere)' : '';
  return `${markers}${entry.title} · ${project} · ${relativeTime(entry.lastActiveAt, nowMs)}${suffix}`;
}

export function statusText(status: StatusSnapshot, nowMs: number): string {
  let state: string;
  if (status.runningSinceMs !== null) {
    state = `running for ${formatDuration(nowMs - status.runningSinceMs)}`;
    if (status.currentTool) state += ` · tool: ${status.currentTool}`;
    if (status.waitingForUser) state += ' · ⏳ waiting for your reply';
  } else {
    state = status.waitingForUser ? '⏳ waiting for your reply' : 'idle';
  }

  const lines = [
    `🧠 Agent: ${status.agent}`,
    `📁 Project: ${status.cwd}`,
    `🧵 Session: ${status.sessionId ? status.sessionId.slice(0, 8) : 'none'}`,
    `⚙️ State: ${state}`,
    `📥 Queue: ${status.queueLength}`,
  ];
  if (status.idleRemainingMs !== null) lines.push(`💤 Session ends in: ${formatDuration(status.idleRemainingMs)}`);
  if (status.limitBlock) {
    const { label, resetsAtMs } = status.limitBlock;
    lines.push(
      `⛔ Reached the ${label} limit · resets at ${formatClock(resetsAtMs, nowMs)} (in ${formatDuration(resetsAtMs - nowMs)})`,
    );
  }
  lines.push(`🤖 Model: ${status.model ?? 'default'} · Effort: ${status.effort ?? 'default'}`);
  if (status.lastTurnCostUsd !== null) lines.push(`💰 Last turn: ~$${status.lastTurnCostUsd.toFixed(4)} (estimated)`);
  if (!status.guardSupported) lines.push('🛡 Guard: not supported by the provider');
  return lines.join('\n');
}

function usageBar(percent: number | null): string {
  const filled = percent === null ? 0 : Math.min(BAR_CELLS, Math.max(0, Math.round(percent / 10)));
  return `${'▓'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}`;
}

export function usageText(report: UsageReport, nowMs: number): string {
  if (!report.available) return '📊 This account has no plan limits (API key or cloud provider).';

  const lines = [`📊 Usage · ${report.subscription ?? 'unknown'} plan`];
  for (const window of report.windows) {
    const percent = window.utilizationPercent === null ? '?%' : `${window.utilizationPercent}%`;
    const reset =
      window.resetsAtMs === null
        ? ''
        : ` · resets ${formatClock(window.resetsAtMs, nowMs)} (in ${formatDuration(window.resetsAtMs - nowMs)})`;
    lines.push(`${window.label}: ${usageBar(window.utilizationPercent)} ${percent}${reset}`);
  }
  lines.push(`💳 Extra usage: ${report.extraUsageEnabled ? 'on' : 'off'}`);
  return lines.join('\n');
}
