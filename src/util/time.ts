const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(safe / MINUTE);
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(safe / HOUR);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `${hours} giờ ${restMinutes} phút` : `${hours} giờ`;
  }
  const days = Math.floor(safe / DAY);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} ngày ${restHours} giờ` : `${days} ngày`;
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
