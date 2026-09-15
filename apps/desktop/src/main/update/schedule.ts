export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/** Checks shortly after start (not during startup work), then every few hours. Returns a stop function. */
export function startSchedule(
  check: () => Promise<unknown>,
  onError: (error: unknown) => void,
  firstDelayMs: number = FIRST_CHECK_DELAY_MS,
  intervalMs: number = CHECK_INTERVAL_MS,
): () => void {
  const run = (): void => {
    check().catch(onError);
  };
  let interval: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    run();
    interval = setInterval(run, intervalMs);
  }, firstDelayMs);
  return () => {
    clearTimeout(first);
    if (interval !== null) clearInterval(interval);
  };
}
