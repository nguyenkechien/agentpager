import type { BadgeState, DaemonView } from '../../shared/api.js';
import { BADGE_LABELS } from '../../shared/labels.js';

export type TrayColor = 'green' | 'amber' | 'grey' | 'red';
export type TrayAction = 'open' | 'start' | 'stop' | 'restart' | 'quit';

export interface TrayItem {
  action: TrayAction;
  label: string;
  enabled: boolean;
}

export interface TrayModel {
  color: TrayColor;
  tooltip: string;
  statusLine: string;
  items: TrayItem[];
}

const COLORS: Record<BadgeState, TrayColor> = {
  running: 'green',
  starting: 'amber',
  restarting: 'amber',
  stopped: 'grey',
  error: 'red',
  unresponsive: 'red',
  disconnected: 'red',
};

/** Nothing answers: Start is the only daemon action that makes sense. */
const NOT_RUNNING: ReadonlySet<BadgeState> = new Set(['stopped', 'error']);

export const QUIT_LABEL = 'Thoát app (bot vẫn chạy)';

/** Tray icon, tooltip and menu for a daemon view; null while the first status read is pending. */
export function trayModel(view: DaemonView | null): TrayModel {
  if (view === null) {
    return {
      color: 'grey',
      tooltip: 'agentpager',
      statusLine: 'Đang đọc trạng thái…',
      items: [
        { action: 'open', label: 'Mở agentpager', enabled: true },
        { action: 'start', label: 'Start', enabled: false },
        { action: 'restart', label: 'Restart', enabled: false },
        { action: 'quit', label: QUIT_LABEL, enabled: true },
      ],
    };
  }
  const label = BADGE_LABELS[view.badge];
  const statusLine = view.badge === 'running' && view.botUsername !== null ? `${label} · @${view.botUsername}` : label;
  const notRunning = NOT_RUNNING.has(view.badge);
  return {
    color: COLORS[view.badge],
    tooltip: `agentpager — ${statusLine}`,
    statusLine,
    items: [
      { action: 'open', label: 'Mở agentpager', enabled: true },
      notRunning ? { action: 'start', label: 'Start', enabled: true } : { action: 'stop', label: 'Stop', enabled: true },
      { action: 'restart', label: 'Restart', enabled: !notRunning },
      { action: 'quit', label: QUIT_LABEL, enabled: true },
    ],
  };
}
