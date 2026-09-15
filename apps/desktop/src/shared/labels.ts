import type { BadgeState } from './api.js';

export function homeOverrideNote(home: string): string {
  return `Using a separate data folder (AGENTPAGER_HOME = ${home}). Autostart and the tray icon at login are machine-wide settings, so they cannot be turned on or off in this mode.`;
}

export const BADGE_LABELS: Record<BadgeState, string> = {
  running: 'Running',
  starting: 'Starting',
  restarting: 'Restarting',
  stopped: 'Stopped',
  error: 'Error',
  unresponsive: 'Bot not responding',
  disconnected: 'Disconnected',
};
