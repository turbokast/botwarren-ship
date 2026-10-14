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
}

export class Replicator {
  private reader: PublicStoreReader;
  private busy = false;
  private timer: NodeJS.Timeout | undefined;
  lastError: string | null = null;
  lastOkAt: string | null = null;
  /** Latest owner-controlled settings from the server (null = none received). */
  settings: ReplicaSettings | null = null;
  readonly cfg: ReplicatorConfig;

  constructor(cfg: ReplicatorConfig) {
    this.cfg = cfg;
    this.reader = new PublicStoreReader(cfg.publicDbPath);
  }

  get cursor(): number { return Number(this.cfg.store.getSetting('replica_cursor') ?? 0); }

  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const m = this.reader.meta();
      const events = this.cfg.holdEvents?.() ? [] : this.reader.after(this.cursor, 200);
      const res = await (this.cfg.fetchImpl ?? fetch)(this.cfg.url, {
        method: 'POST',
        headers: { ...(this.cfg.headers ?? {}), authorization: `Bearer ${this.cfg.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ meta: { paused: m.paused === '1', delaySeconds: Number(m.delay_seconds ?? 90), demo: m.demo === '1', epoch: m.epoch ?? '0', ...(m.ship ? { ship: JSON.parse(m.ship) } : {}) }, events }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error', // the bearer secret must never follow a redirect
      });
      if (!res.ok) throw new Error(`replica HTTP ${res.status}`);
      const r = JSON.parse(await readCappedText(res, MAX_REPLICA_RESPONSE)) as { maxSeq?: unknown; settings?: unknown };
      // The remote's max seq is the cursor. It may move BACK (a wiped remote refills from the start) but never past what exists locally:
      // a server must not be able to talk the agent into skipping events it has not sent yet, or into a nonsense cursor.
      const ack = r.maxSeq;
      if (typeof ack !== 'number' || !Number.isInteger(ack) || ack < 0 || ack > MAX_SEQ) throw new Error('replica sent an invalid cursor');
      if (ack > this.reader.maxSeq()) throw new Error('replica cursor is beyond the local log');
      this.cfg.store.setSetting('replica_cursor', String(ack));
      const settings = ReplicaSettings.safeParse(r.settings);
      this.settings = settings.success ? settings.data : null;
      this.cfg.onSettings?.(this.settings);
      this.lastOkAt = new Date().toISOString();
      this.lastError = null;
      return events.length;
    } catch (e) {
      this.lastError = (e as Error).message;
      return 0;
    } finally {
      this.busy = false;
    }
  }

  start(intervalMs = 2000): void { this.timer = setInterval(() => void this.tick(), intervalMs); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}
