import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  // browsers only honour this on HTTPS (it is ignored over plain http); preload is deliberately NOT requested yet
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(data);
}

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Constant-time bearer token comparison (hashes first so lengths always match). */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

export function cookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return undefined; } } // a malformed value is just absent
  }
  return undefined;
}

/**
 * Fixed-window rate limiter with bounded memory and no fail-closed mode
 *  - per-key budget (`max` per `windowMs`);
 *  - the table holds at most `capacity` keys. Entries are kept in insertion order, which is also expiry order (one window
 *    length for everybody), so when the table is full the OLDEST entry is evicted instead of rejecting the newcomer.
 *    A flood of fresh keys can therefore only reset other keys' counters, never lock real visitors out;
 *  - a global backstop: at most `globalMax` allowed calls per window across ALL keys (default `max * 100`), so rotating
 *    through keys cannot multiply the budget without bound. Calls over the backstop are rejected without touching the table.
 */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly capacity: number;
  private readonly globalMax: number;
  private gN = 0;
  private gReset = -Infinity;
  constructor(max: number, windowMs: number, capacity = 20_000, opts: { globalMax?: number } = {}) {
    this.max = max; this.windowMs = windowMs; this.capacity = Math.max(1, capacity); this.globalMax = opts.globalMax ?? max * 100;
  }
  allow(key: string, now = Date.now()): boolean {
    if (this.gReset < now) { this.gN = 0; this.gReset = now + this.windowMs; }
    if (this.gN >= this.globalMax) return false; // global backstop
    const h = this.hits.get(key);
    if (h && h.reset >= now) {
      h.n++;
      if (h.n > this.max) return false;
      this.gN++;
      return true;
    }
    // new key, or its window has passed: (re)insert at the back so insertion order stays expiry order
    if (h) this.hits.delete(key);
    while (this.hits.size >= this.capacity) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
    this.hits.set(key, { n: 1, reset: now + this.windowMs });
    this.gN++;
    return true;
  }
  get size(): number { return this.hits.size; }
}

function expandIPv6(a: string): number[] | null {
  let s = a;
  let tail: number[] | null = null;
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const o = [v4[2], v4[3], v4[4], v4[5]].map(Number);
    if (o.some((x) => x! > 255)) return null;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    s = v4[1]! + '0:0';
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const toNums = (x: string) => (x === '' ? [] : x.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = toNums(parts[0]!);
  const rest = parts.length === 2 ? toNums(parts[1]!) : [];
  let g: number[];
  if (parts.length === 2) { const fill = 8 - head.length - rest.length; if (fill < 1) return null; g = [...head, ...new Array<number>(fill).fill(0), ...rest]; }
  else g = head;
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return null;
  if (tail) { g[6] = tail[0]!; g[7] = tail[1]!; }
  return g;
}

/**
 * The rate-limit identity of an address: IPv4 by the full address, IPv6 by its /64 (a single subscriber or attacker owns
 * a whole /64, i.e. 2^64 addresses), IPv4-mapped IPv6 (::ffff:a.b.c.d) as the IPv4 address. Anything unparseable is kept as is.
 */
export function addressKey(addr: string): string {
  const a = addr.trim().toLowerCase();
  if (!a.includes(':')) return a;
  const g = expandIPv6(a);
  if (!g) return a;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * Client identity for rate limits: the socket peer address normalised by addressKey (IPv6 by /64). The agent's ops room listens on
 * loopback only and never trusts forwarded headers.
 */
export function clientId(req: IncomingMessage): string {
  return addressKey(req.socket.remoteAddress ?? '?');
}
