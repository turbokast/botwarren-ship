/**
 * Outbound replication of ALREADY-PUBLISHED public events to a remote public service.
 * Private data never leaves this machine: the replicator reads only public.db.
 * Cursor = remote-confirmed max seq; a wiped/reset remote is re-filled automatically.
 */
import { ReplicaSettings } from '../vendor/core/contract.ts';
import { PublicStoreReader, type PrivateStore } from './stores.ts';

/** Largest publish response we will read: a real one is a few hundred bytes (maxSeq, epoch, settings). */
export const MAX_REPLICA_RESPONSE = 16_384;
/** Highest sequence number we accept as an acknowledgement (sanity bound, well above anything a real store reaches). */
const MAX_SEQ = 2 ** 53 - 1;

/** Reads a response body as UTF-8 text, giving up (throws) once it exceeds `limit` bytes; never buffers more than `limit` + one chunk. */
export async function readCappedText(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('replica response too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { void reader.cancel().catch(() => undefined); throw new Error('replica response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Publish cadence. The server directs it in every publish response (`nextIntervalMs`: the idle heartbeat, `minIntervalMs`: the fastest
 * flush when there are events) and answers 503/429/507 with `Retry-After` (docs/OPERATIONS.md, "Heartbeat contract"). A server that
 * says nothing (an older one) leaves the old fixed 2 s cadence. Whatever it says is clamped: never faster than 1 s, never slower than
 * 60 s (the site calls a ship offline after 120 s without a heartbeat, so a wrong or hostile value must not make the ship look dead).
 */
export interface Cadence { idleMs: number; minMs: number; fromServer: boolean }
export const DEFAULT_CADENCE: Cadence = { idleMs: 2000, minMs: 2000, fromServer: false };
export const CADENCE_FLOOR_MS = 1000;
export const CADENCE_CEILING_MS = 60_000;
/** longest we will wait because the server said `Retry-After` */
export const RETRY_AFTER_CEILING_MS = 300_000;
const BACKOFF_CEILING_MS = 60_000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads the cadence out of a publish response body (success or error); null when it carries none. */
export function parseCadence(body: unknown): Cadence | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { nextIntervalMs?: unknown; minIntervalMs?: unknown };
  if (!finite(b.nextIntervalMs) && !finite(b.minIntervalMs)) return null;
  const minMs = finite(b.minIntervalMs) ? clamp(Math.round(b.minIntervalMs), CADENCE_FLOOR_MS, CADENCE_CEILING_MS) : DEFAULT_CADENCE.minMs;
  const idleMs = finite(b.nextIntervalMs) ? clamp(Math.round(b.nextIntervalMs), minMs, CADENCE_CEILING_MS) : minMs;
  return { idleMs, minMs, fromServer: true };
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date; null when absent or unusable. Clamped to 1 s .. 5 min. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  let ms: number;
  if (/^\d{1,12}$/.test(v)) ms = Number(v) * 1000;
  else if (/^[A-Za-z]{3,9}[, ]/.test(v)) { const t = Date.parse(v); if (!Number.isFinite(t)) return null; ms = t - nowMs; } // an HTTP date
  else return null;
  return clamp(ms, 1000, RETRY_AFTER_CEILING_MS);
}

/** the parts of the store's meta that go into the heartbeat body (a change in any of them is worth posting soon) */
const metaSig = (m: Record<string, string>): string => JSON.stringify([m.paused, m.delay_seconds, m.demo, m.epoch, m.ship]);

export interface ReplicatorConfig {
  url: string; secret: string; publicDbPath: string; store: PrivateStore; fetchImpl?: typeof fetch;
  /**
   * Called after every successful publish with the owner-controlled settings in the response, or null when the
   * server sent none (old server / unknown shape): callers must then behave as if every setting were off.
   */
  onSettings?: (settings: ReplicaSettings | null) => void;
  /** While true, a publish carries the heartbeat (meta) but NO events: they stay queued and flow after resume. */
  holdEvents?: () => boolean;
  /** Extra request headers (the ship agent reports its version). */
  headers?: Record<string, string>;
  /** injectable for tests */
  now?: () => number;
  random?: () => number;
}

/** A request gets this long (headers and body); then it is aborted. */
const REQUEST_TIMEOUT_MS = 10_000;
/** A publish not settled by then is abandoned whatever the fetch does: a request that never settles must not keep `busy` set and the ship offline. */
export const PUBLISH_DEADLINE_MS = 15_000;

/** Runs `work` with a signal aborted after `timeoutMs`; rejects at `deadlineMs` even if `work` never settles. */
export async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, deadlineMs: number): Promise<T> {
  const ctl = new AbortController();
  const soft = setTimeout(() => ctl.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeoutMs);
  let hard: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work(ctl.signal), new Promise<never>((_, reject) => {
      hard = setTimeout(() => { ctl.abort(); reject(new Error('publish did not finish in time')); }, deadlineMs);
    })]);
  } finally {
    clearTimeout(soft); clearTimeout(hard);
  }
}

export class Replicator {
  private reader: PublicStoreReader;
  private busy = false;
  private timer: NodeJS.Timeout | undefined;
  lastError: string | null = null;
  lastOkAt: string | null = null;
  /** Latest owner-controlled settings from the server (null = none received). */
  settings: ReplicaSettings | null = null;
  /** Latest cadence directed by the server (the old fixed 2 s until it says otherwise). */
  cadence: Cadence = DEFAULT_CADENCE;
  /** Wall-clock ms before which no publish is attempted (a `Retry-After`, or the backoff after consecutive failures). */
  retryAtMs = 0;
  private fails = 0;
  /** consecutive publishes the website refused with 401 (secret revoked or replaced), and when that started; any other answer resets it */
  unauthorized: { count: number; since: number | null } = { count: 0, since: null };
  private lastAttemptMs = 0;
  private lastMetaSig = '';
  /** per-cycle jitter on the wait (0.9 .. 1.1) so a fleet that restarts together does not stay in step */
  private jitter = 1;
  readonly cfg: ReplicatorConfig;

  constructor(cfg: ReplicatorConfig) {
    this.cfg = cfg;
    this.reader = new PublicStoreReader(cfg.publicDbPath);
  }

  get cursor(): number { return Number(this.cfg.store.getSetting('replica_cursor') ?? 0); }

  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    this.lastAttemptMs = this.now();
    this.jitter = 0.9 + this.rand() * 0.2;
    try {
      return await withDeadline((signal) => this.publish(signal), REQUEST_TIMEOUT_MS, PUBLISH_DEADLINE_MS);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.fails++;
      // Retry-After (set in publish) wins; otherwise back off exponentially from the flush interval, with jitter, up to a minute
      if (this.retryAtMs <= this.now()) this.retryAtMs = this.now() + Math.round(Math.min(BACKOFF_CEILING_MS, this.cadence.minMs * 2 ** Math.min(this.fails - 1, 6)) * this.jitter);
      return 0;
    } finally {
      this.busy = false;
    }
  }

  private async publish(signal: AbortSignal): Promise<number> {
    const m = this.reader.meta();
    this.lastMetaSig = metaSig(m);
    const events = this.cfg.holdEvents?.() ? [] : this.reader.after(this.cursor, 200);
    const res = await (this.cfg.fetchImpl ?? fetch)(this.cfg.url, {
      method: 'POST',
      headers: { ...(this.cfg.headers ?? {}), authorization: `Bearer ${this.cfg.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { paused: m.paused === '1', delaySeconds: Number(m.delay_seconds ?? 90), demo: m.demo === '1', epoch: m.epoch ?? '0', ...(m.ship ? { ship: JSON.parse(m.ship) } : {}) }, events }),
      signal,
      redirect: 'error', // the bearer secret must never follow a redirect
    });
    if (!res.ok) {
      if (res.status === 401) { this.unauthorized = { count: this.unauthorized.count + 1, since: this.unauthorized.since ?? this.now() }; } else this.unauthorized = { count: 0, since: null };
      // 503/429/507 carry Retry-After and the cadence to use afterwards (the body is small JSON; anything else is ignored)
      const wait = parseRetryAfter(res.headers.get('retry-after'), this.now());
      if (wait !== null) this.retryAtMs = this.now() + wait;
      try { const c = parseCadence(JSON.parse(await readCappedText(res, MAX_REPLICA_RESPONSE))); if (c) this.cadence = c; } catch { /* no usable body */ }
      throw new Error(`replica HTTP ${res.status}`);
    }
    const r = JSON.parse(await readCappedText(res, MAX_REPLICA_RESPONSE)) as { maxSeq?: unknown; settings?: unknown; laneReset?: unknown; nextIntervalMs?: unknown; minIntervalMs?: unknown };
    // The remote's max seq is the cursor. It may move BACK (a wiped remote refills from the start) but never past what exists locally:
    // a server must not be able to talk the agent into skipping events it has not sent yet, or into a nonsense cursor.
    const ack = r.maxSeq;
    if (typeof ack !== 'number' || !Number.isInteger(ack) || ack < 0 || ack > MAX_SEQ) throw new Error('replica sent an invalid cursor');
    if (ack > this.reader.maxSeq()) throw new Error('replica cursor is beyond the local log');
    signal.throwIfAborted(); // an abandoned publish must not move the cursor under a newer one
    // The exception is a lane reset (this installation just became the ship's agent, e.g. after pairing): the remote only restarted ITS
    // count for this installation, the history is already there, so the cursor never moves backwards and old events are not resent.
    this.cfg.store.setSetting('replica_cursor', String(r.laneReset === true ? Math.max(this.cursor, ack) : ack));
    const settings = ReplicaSettings.safeParse(r.settings);
    this.settings = settings.success ? settings.data : null;
    this.cadence = parseCadence(r) ?? DEFAULT_CADENCE; // a server that stops sending it (a rollback) puts us back on the old cadence
    this.fails = 0; this.retryAtMs = 0; this.unauthorized = { count: 0, since: null };
    this.cfg.onSettings?.(this.settings);
    this.lastOkAt = new Date().toISOString();
    this.lastError = null;
    return events.length;
  }

  private now(): number { return this.cfg.now?.() ?? Date.now(); }
  private rand(): number { return this.cfg.random?.() ?? Math.random(); }

  /**
   * Is a publish due? Events waiting (or a changed heartbeat payload, e.g. paused or the delay) flush at the server's `minIntervalMs`;
   * otherwise the idle heartbeat applies (`nextIntervalMs`). Nothing is attempted before a `Retry-After` / backoff has passed.
   */
  dueNow(nowMs = this.now()): boolean {
    if (nowMs < this.retryAtMs) return false;
    const pending = (!this.cfg.holdEvents?.() && this.reader.maxSeq() > this.cursor) || metaSig(this.reader.meta()) !== this.lastMetaSig;
    return nowMs - this.lastAttemptMs >= Math.round((pending ? this.cadence.minMs : this.cadence.idleMs) * this.jitter);
  }

  /** Polls the local store once a second (cheap, no network) and publishes only when `dueNow()`. */
  start(pollMs = 1000): void {
    this.timer = setInterval(() => { try { if (this.dueNow()) void this.tick(); } catch (e) { this.lastError = (e as Error).message; } }, pollMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}
