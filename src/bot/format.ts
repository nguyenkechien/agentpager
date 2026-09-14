import type { StatusSnapshot } from '../sessions/manager.js';
import type { HistoryEntry } from '../sessions/history.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs);
  if (diff < MINUTE) return 'vừa xong';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} phút trước`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} giờ trước`;
  return `${Math.floor(diff / DAY)} ngày trước`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} giờ ${rest} phút` : `${hours} giờ`;
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
    `📁 Project: ${status.cwd}`,
    `🧵 Session: ${status.sessionId ? status.sessionId.slice(0, 8) : 'chưa có'}`,
    `⚙️ Trạng thái: ${state}`,
    `📥 Hàng đợi: ${status.queueLength}`,
  ];
  if (status.idleRemainingMs !== null) lines.push(`💤 Hết phiên sau: ${formatDuration(status.idleRemainingMs)}`);
  lines.push(`🤖 Model: ${status.model ?? 'mặc định'} · Effort: ${status.effort ?? 'mặc định'}`);
  if (status.lastTurnCostUsd !== null) lines.push(`💰 Lượt cuối: ~$${status.lastTurnCostUsd.toFixed(4)} (ước tính)`);
  return lines.join('\n');
}
