/**
 * Context-window fill of a Claude Code session, METADATA ONLY.
 *
 * Reads exactly the numeric token counts of `message.usage` (input / cache creation / cache read) of an assistant
 * line plus the model family string and the type/subtype of compact boundary markers. Message text is never read.
 * The numbers are converted locally to a fraction of the model's context window and BUCKETED into the public enum
 * (`ContextFill`); only the bucket ever leaves this module, never a token count or the window size.
 *
 * Window assumption (conservative):
 *   - opus / sonnet / haiku family: 200 000 tokens.
 *   - a session whose usage has EVER exceeded 200 000 must be on the 1 000 000 window, and stays there (sticky).
 *     Logs do not record the window, so a 1M session below 200k tokens reads as if it had a 200k window (it can only
 *     look fuller than it is, never emptier; it self-corrects once usage passes 200k).
 *   - any other model (gpt, other, none) is 'unknown': no value is invented.
 */
import { bucketContext, type ContextFill } from '../vendor/core/contract.ts';
import { modelFamily } from './subagents.ts';

export const WINDOW_STD = 200_000;
export const WINDOW_LONG = 1_000_000;

/** Numeric usage block of an assistant message (`message.usage`). Anything non-numeric is ignored. */
export function usedTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const n = (k: string): number => { const v = u[k]; return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? v : 0; };
  const total = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
  return total > 0 ? total : null;
}

/** Context window of a model family string, or null when it is not a family with a known window. */
export function windowFor(model: string | undefined, sticky1m: boolean): number | null {
  const fam = modelFamily(model);
  if (fam !== 'opus' && fam !== 'sonnet' && fam !== 'haiku') return null;
  return sticky1m ? WINDOW_LONG : WINDOW_STD;
}

/** Bucket of `used` tokens for a model, given whether the session has been seen above the standard window. */
export function fillFor(used: number | null, model: string | undefined, sticky1m: boolean): ContextFill {
  if (used === null) return 'unknown';
  const w = windowFor(model, sticky1m || used > WINDOW_STD);
  if (w === null) return 'unknown';
  return bucketContext(used / w);
}

/** Per-session tracker: feed it the usage of each assistant line in order; it reports bucket changes and compactions. */
export class ContextTracker {
  private sticky1m = false;
  private model: string | undefined;
  private last: ContextFill = 'unknown';
  private emittedAt = 0;

  /** `used`: tokens of the newest assistant message; returns the new bucket when it is worth an event, else null. */
  usage(used: number | null, model: string | undefined, atMs: number, keepaliveMs = 10 * 60_000): ContextFill | null {
    if (typeof model === 'string' && model !== '<synthetic>') this.model = model;
    if (used === null) return null;
    if (used > WINDOW_STD) this.sticky1m = true;
    const f = fillFor(used, this.model, this.sticky1m);
    if (f === 'unknown') return null;
    if (f === this.last && atMs - this.emittedAt < keepaliveMs) return null;
    this.last = f; this.emittedAt = atMs;
    return f;
  }

  /** the session was seen above the standard window, so it is on the long one */
  markLong(): void { this.sticky1m = true; }

  /** A compact boundary: the window is emptied. Fill afterwards is re-measured by the next assistant message. */
  compacted(): void { this.last = 'unknown'; }
}
