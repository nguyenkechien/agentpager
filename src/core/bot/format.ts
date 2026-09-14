import type { UsageReport } from '../../providers/types.js';
import { formatClock, formatDuration } from '../../util/time.js';
import type { HistoryEntry } from '../sessions/history.js';
import type { StatusSnapshot } from '../sessions/manager.js';

export { formatClock, formatDuration };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BAR_CELLS = 10;

export function relativeTime(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs);
  if (diff < MINUTE) return 'vừa xong';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} phút trước`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} giờ trước`;
  return `${Math.floor(diff / DAY)} ngày trước`;
}

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

export function historyLine(entry: HistoryEntry, nowMs: number, mode: 'bot' | 'all'): string {
  const markers = `${mode === 'all' && entry.botOwned ? '🤖 ' : ''}${entry.maybeOpenElsewhere ? '⚠️ ' : ''}`;
  const project = entry.cwd ? projectName(entry.cwd) : '?';
  const suffix = entry.maybeOpenElsewhere ? ' (có thể đang mở ở nơi khác)' : '';
  return `${markers}${entry.title} · ${project} · ${relativeTime(entry.lastActiveAt, nowMs)}${suffix}`;
}

export function statusText(status: StatusSnapshot, nowMs: number): string {
  let state: string;
  if (status.runningSinceMs !== null) {
    state = `đang chạy ${formatDuration(nowMs - status.runningSinceMs)}`;
    if (status.currentTool) state += ` · tool: ${status.currentTool}`;
    if (status.waitingForUser) state += ' · ⏳ đang chờ bạn trả lời';
  } else {
    state = status.waitingForUser ? '⏳ đang chờ bạn trả lời' : 'rảnh';
  }

  const lines = [
    `🧠 Agent: ${status.agent}`,
    `📁 Project: ${status.cwd}`,
    `🧵 Session: ${status.sessionId ? status.sessionId.slice(0, 8) : 'chưa có'}`,
    `⚙️ Trạng thái: ${state}`,
    `📥 Hàng đợi: ${status.queueLength}`,
  ];
  if (status.idleRemainingMs !== null) lines.push(`💤 Hết phiên sau: ${formatDuration(status.idleRemainingMs)}`);
  if (status.limitBlock) {
    const { label, resetsAtMs } = status.limitBlock;
    lines.push(
      `⛔ Hết limit ${label} · reset lúc ${formatClock(resetsAtMs, nowMs)} (còn ${formatDuration(resetsAtMs - nowMs)})`,
    );
  }
  lines.push(`🤖 Model: ${status.model ?? 'mặc định'} · Effort: ${status.effort ?? 'mặc định'}`);
  if (status.lastTurnCostUsd !== null) lines.push(`💰 Lượt cuối: ~$${status.lastTurnCostUsd.toFixed(4)} (ước tính)`);
  if (!status.guardSupported) lines.push('🛡 Guard: provider không hỗ trợ');
  return lines.join('\n');
}

function usageBar(percent: number | null): string {
  const filled = percent === null ? 0 : Math.min(BAR_CELLS, Math.max(0, Math.round(percent / 10)));
  return `${'▓'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}`;
}

export function usageText(report: UsageReport, nowMs: number): string {
  if (!report.available) return '📊 Tài khoản này không có limit theo gói (API key hoặc cloud provider).';

  const lines = [`📊 Usage · gói ${report.subscription ?? 'không rõ'}`];
  for (const window of report.windows) {
    const percent = window.utilizationPercent === null ? '?%' : `${window.utilizationPercent}%`;
    const reset =
      window.resetsAtMs === null
        ? ''
        : ` · reset ${formatClock(window.resetsAtMs, nowMs)} (còn ${formatDuration(window.resetsAtMs - nowMs)})`;
    lines.push(`${window.label}: ${usageBar(window.utilizationPercent)} ${percent}${reset}`);
  }
  lines.push(`💳 Extra usage: ${report.extraUsageEnabled ? 'bật' : 'tắt'}`);
  return lines.join('\n');
}
