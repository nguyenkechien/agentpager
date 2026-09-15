const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A count with its noun in the right number: "1 turn", "2 turns". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

/** "45 seconds", "3 minutes", "2 hours 5 minutes", "1 day 3 hours". */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < MINUTE) return plural(Math.floor(safe / 1000), 'second');
  if (safe < HOUR) return plural(Math.floor(safe / MINUTE), 'minute');
  if (safe < DAY) {
    const hours = Math.floor(safe / HOUR);
    const minutes = Math.floor((safe % HOUR) / MINUTE);
    return minutes === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(minutes, 'minute')}`;
  }
  const days = Math.floor(safe / DAY);
  const hours = Math.floor((safe % DAY) / HOUR);
  return hours === 0 ? plural(days, 'day') : `${plural(days, 'day')} ${plural(hours, 'hour')}`;
}

/** Local date and time, e.g. "14/09/2026 16:05". */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
