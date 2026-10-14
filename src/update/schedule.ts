/** Check cadence: at most every 6 h, plus jitter so a fleet never checks in lockstep; failures back off to 24 h. */
export const CHECK_INTERVAL_MS = 6 * 3_600_000;
export const CHECK_JITTER_MS = 3_600_000;
export const STARTUP_JITTER_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 24 * 3_600_000;

/** When to check next, from `nowMs`, after `failures` consecutive failures. */
export function nextCheckAt(nowMs: number, failures: number, rand: () => number = Math.random): number {
  const base = failures <= 0 ? CHECK_INTERVAL_MS : Math.min(MAX_BACKOFF_MS, CHECK_INTERVAL_MS * 2 ** Math.min(failures, 4));
  return nowMs + base + Math.floor(rand() * CHECK_JITTER_MS);
}

/** First check after (re)start: never before the persisted next-check time, and not at once (0..5 min jitter). */
export function firstCheckAt(nowMs: number, persistedNextMs: number, rand: () => number = Math.random): number {
  return Math.max(persistedNextMs, nowMs + Math.floor(rand() * STARTUP_JITTER_MS));
}
