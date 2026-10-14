/**
 * OpenCode adapter (https://opencode.ai). Read-only, via OpenCode's LOCAL HTTP server (`opencode serve`, default
 * 127.0.0.1:4096; the TUI starts one on a chosen port with --port). Allowlist: exactly `GET /session/status` and
 * `GET /session`. UNVERIFIED shapes (documented in opencode.ai/docs/server, no live recording): we therefore verify the
 * shape before trusting the port, and report `unexpected_shape` otherwise.
 *
 *   GET /session/status -> { "<sessionID>": { "type": "idle" | "busy" | "retry", ... } }
 *   GET /session        -> [ { id, directory?, parentID?, title?, time: { created, updated } }, ... ]
 *
 * Kept: session id (key + correlation), busy/retry -> working, idle -> idle, parentID -> sub-agent role, directory ->
 * local cwd for attribution, time.updated -> recency. Dropped: title and every other field. The message endpoints
 * (/session/:id/message, /diff, ...) are not reachable.
 */
import { ADAPTER_API_VERSION, safeErrorCode, type Adapter, type AdapterContext, type AdapterManifest, type DetectEnv, type Detection, type Observation } from './api.ts';

export const OPENCODE_ALLOW = ['/session/status', '/session'] as const;
export const OPENCODE_DEFAULT_PORT = 4096;
const ACTIVE_MS = 30 * 60_000;
const ID_OK = /^[0-9A-Za-z_-]{1,80}$/;

export function verifyOpencodeShape(statusBody: string, listBody: string): { status: Record<string, string>; list: Record<string, unknown>[] } | null {
  let s: unknown; let l: unknown;
  try { s = JSON.parse(statusBody); l = JSON.parse(listBody); } catch { return null; }
  if (!s || typeof s !== 'object' || Array.isArray(s) || !Array.isArray(l)) return null;
  const status: Record<string, string> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || typeof (v as { type?: unknown }).type !== 'string') return null;
    status[k] = (v as { type: string }).type;
  }
  const list = l.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
  if (list.length !== l.length || !list.slice(0, 50).every((o) => typeof o.id === 'string')) return null;
  return { status, list };
}

interface Seen { sig: string; lastEmit: number }

export class OpenCodeAdapter implements Adapter {
  readonly manifest: AdapterManifest = {
    id: 'opencode', apiVersion: ADAPTER_API_VERSION, version: '1.0.0', platforms: ['win32', 'darwin', 'linux'],
    reads: [
      { kind: 'loopback-http', target: 'GET /session/status', keeps: 'session ids and idle/busy/retry state' },
      { kind: 'loopback-http', target: 'GET /session', keeps: 'session id, parent link, working folder (local only), last-updated time. Titles are dropped.' },
    ],
    capabilities: { state: true, toolCategory: false, errors: false, subagents: true, tokens: false, hierarchy: true },
    upstream: { name: 'OpenCode', tested: 'docs only (opencode.ai/docs/server)', verification: 'unverified' },
    summary: 'OpenCode sessions through its local server (start it with `opencode serve`; default port 4096).',
  };
  private readonly seen = new Map<string, Seen>();
  private readonly reobserveMs: number;
  constructor(reobserveMs = 120_000) { this.reobserveMs = reobserveMs; }

  async detect(env: DetectEnv): Promise<Detection> {
    const port = env.settings.port ?? OPENCODE_DEFAULT_PORT;
    const a = await env.probe([...OPENCODE_ALLOW], port, '/session/status', env.settings.host);
    const b = a && a.status === 200 ? await env.probe([...OPENCODE_ALLOW], port, '/session', env.settings.host) : null;
    if (a && b && a.status === 200 && b.status === 200) {
      return verifyOpencodeShape(a.body, b.body)
        ? { found: true, confidence: 'high', note: `verified on 127.0.0.1:${port}` }
        : { found: false, confidence: 'high', note: `something else is listening on 127.0.0.1:${port}; ignored` };
    }
    return env.hasCommand('opencode') ? { found: true, confidence: 'low', note: 'installed; no local server found (run `opencode serve`, or set adapters.opencode.port)' } : { found: false, confidence: 'high' };
  }

  async poll(ctx: AdapterContext, now: Date): Promise<Observation[]> {
    const nowMs = now.getTime();
    let shape: ReturnType<typeof verifyOpencodeShape>;
    try {
      const [a, b] = [await ctx.http.get('/session/status'), await ctx.http.get('/session', { maxBytes: 2 * 1024 * 1024 })];
      if (a.status !== 200 || b.status !== 200) return [{ kind: 'adapter.health', state: 'degraded', code: 'unreachable' }];
      shape = verifyOpencodeShape(a.body, b.body);
    } catch (e) {
      if (safeErrorCode(e) !== 'ECONNREFUSED') ctx.log('unreachable');
      return this.seen.size > 0 ? [{ kind: 'adapter.health', state: 'degraded', code: 'unreachable' }] : [];
    }
    if (!shape) { ctx.log('unexpected_shape'); return [{ kind: 'adapter.health', state: 'unsupported_version', code: 'unexpected_shape' }]; }
    const out: Observation[] = [{ kind: 'adapter.health', state: 'ok', code: 'none' }];
    const ids = new Set(shape.list.map((s) => String(s.id)));
    const present = new Set<string>();
    let n = 0;
    for (const s of shape.list) {
      const id = String(s.id);
      const st = shape.status[id];
      const time = s.time as { updated?: unknown } | undefined;
      const updated = typeof time?.updated === 'number' ? time.updated : null;
      const recent = updated !== null ? nowMs - updated <= ACTIVE_MS : false;
      if (!ID_OK.test(id) || (!recent && (st === undefined || st === 'idle')) || n >= 100) continue;
      n++;
      const key = `opencode:${id}`;
      present.add(key);
      const status = st === 'busy' || st === 'retry' ? 'working' : 'idle';
      const parent = typeof s.parentID === 'string' && ids.has(s.parentID) && ID_OK.test(s.parentID) ? s.parentID : null;
      const cwd = typeof s.directory === 'string' && s.directory.length > 0 && s.directory.length <= 1024 ? s.directory : null;
      const projectId = await ctx.attribute(cwd, nowMs);
      const sig = `${status}|${parent ?? ''}|${projectId ?? ''}`;
      const prev = this.seen.get(key);
      if (!prev || prev.sig !== sig || nowMs - prev.lastEmit >= this.reobserveMs) {
        this.seen.set(key, { sig, lastEmit: nowMs });
        out.push({
          kind: 'session', key, tool: 'opencode', harness: 'unknown', status, projectId, certainty: 'observed',
          correlate: [{ type: 'opencode-session', id }],
          ...(parent ? { role: 'subagent' as const, parentKey: `opencode:${parent}` } : {}),
          local: cwd ? { cwd } : {},
        });
      }
    }
    for (const key of [...this.seen.keys()]) {
      if (present.has(key)) continue;
      this.seen.delete(key);
      out.push({ kind: 'session.ended', key, reason: 'unknown' });
    }
    return out;
  }
}
