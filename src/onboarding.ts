/**
 * The first minutes of a new ship: publishing uses the 30 s minimum delay (instead of the configured one) so the first crew
 * member appears quickly, then the configured delay applies again. The window is the config's `onboardingUntil`, which
 * `botwarren pair` writes. A change made in the ops room during the window is replaced when it ends; outside the window
 * nothing here touches the delay.
 *
 * "short" is remembered in a private setting, so a restart in the middle of the window, or after it, restores the configured
 * delay exactly once and never overrides a delay the owner picked later.
 */
export const ONBOARDING_DELAY_SECONDS = 30;
export const ONBOARDING_MINUTES = 15;

/** The part of PrivateService this needs (settings table and the audited delay setter). */
export interface DelayTarget {
  store: { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void };
  setDelay(seconds: number, actor: string): void;
}

const MARK = 'onboarding_delay';

/**
 * Applies the right delay for `now` and returns the ms until the window ends (null = no window running). The caller arms a
 * timer for that long and calls this again.
 */
export function applyOnboardingDelay(target: DelayTarget, cfg: { onboardingUntil: number | null; delaySeconds: number }, now: number): number | null {
  const marked = target.store.getSetting(MARK) === 'on';
  const left = cfg.onboardingUntil === null ? 0 : cfg.onboardingUntil - now;
  if (left > 0) {
    if (!marked) { target.setDelay(ONBOARDING_DELAY_SECONDS, 'onboarding'); target.store.setSetting(MARK, 'on'); }
    return left;
  }
  if (marked) { target.setDelay(cfg.delaySeconds, 'onboarding'); target.store.setSetting(MARK, 'off'); }
  return null;
}

/** The config timestamp for a window starting now. */
export function onboardingUntilIso(now: number): string { return new Date(now + ONBOARDING_MINUTES * 60_000).toISOString(); }
