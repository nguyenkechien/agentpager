const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** "1 minute", "2 minutes"; `unit` is the singular form and takes a plain "s" plural. */
export function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return plural(seconds, 'second');
  const minutes = Math.floor(safe / MINUTE);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(safe / HOUR);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `${plural(hours, 'hour')} ${plural(restMinutes, 'minute')}` : plural(hours, 'hour');
  }
  const days = Math.floor(safe / DAY);
  const restHours = hours % 24;
  return restHours > 0 ? `${plural(days, 'day')} ${plural(restHours, 'hour')}` : plural(days, 'day');
}

/** Local wall-clock time; the date is added when it is not today. */
export function formatClock(ms: number, nowMs: number): string {
  const date = new Date(ms);
  const now = new Date(nowMs);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? time : `${time} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}
