const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "45 giây", "3 phút", "2 giờ 5 phút", "1 ngày 3 giờ". */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < MINUTE) return `${String(Math.floor(safe / 1000))} giây`;
  if (safe < HOUR) return `${String(Math.floor(safe / MINUTE))} phút`;
  if (safe < DAY) {
    const hours = Math.floor(safe / HOUR);
    const minutes = Math.floor((safe % HOUR) / MINUTE);
    return minutes === 0 ? `${String(hours)} giờ` : `${String(hours)} giờ ${String(minutes)} phút`;
  }
  const days = Math.floor(safe / DAY);
  const hours = Math.floor((safe % DAY) / HOUR);
  return hours === 0 ? `${String(days)} ngày` : `${String(days)} ngày ${String(hours)} giờ`;
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
