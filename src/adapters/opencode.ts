/**
 * OpenCode adapter (https://opencode.ai). Read-only, via OpenCode's LOCAL HTTP server on loopback. Two API generations:
 *
 * v2 (OpenCode 2.x; OpenAPI document and empty-server responses read from v2.0.21; `opencode serve` listens on 127.0.0.1:4096 by
 * default, the background service on whatever port it was given: set `adapters.opencode.port`). Every JSON response is wrapped in `data`:
 *   GET /api/session/active      -> { data: { "<sessionID>": { type: "running" } } }              (idle sessions are absent)
 *   GET /api/session             -> { data: [ { id, parentID?, location: { directory }, time: { created, updated }, ... } ], cursor }
 *   GET /api/permission/request  -> { location, data: [ { id, sessionID, action, resources[], message?, ... } ] }   (a session waits for approval)
 *   GET /api/form                -> { location, data: [ { id, sessionID, fields[], ... } ] }                         (a session waits for an answer)
 * The v2 server ALWAYS wants HTTP Basic credentials (user `opencode`, password = OPENCODE_SERVER_PASSWORD, or the random one a standalone
 * server prints). Without them it answers 401 {"_tag":"UnauthorizedError",...}. The agent never reads OpenCode's files or credential store;
 * it uses the password only if the user put it in the agent's own environment, and sends it only after the server has identified itself
 * with that exact 401 body. Without it the adapter reports `policy_denied` and observes nothing.
 * The permission and form lists are scoped by OpenCode to its own working folder (the `location`), and a query string is refused by
 * our policy, so "blocked" is best-effort: sessions waiting in other folders show as working.
 *
 * v1 (OpenCode 1.x, documented in opencode.ai/docs/server, no live recording): `GET /session/status` -> { "<id>": { type: idle|busy|retry } },
 * `GET /session` -> [ { id, directory?, parentID?, title?, time } ]. Optional Basic auth via the same environment password.
 *
 * Shape verified before a port is trusted (a v2 server answers the v1 paths with its web app: HTML, rejected). Kept: session id (key +
 * correlation), running/busy/retry -> working, waiting for permission or question -> blocked, parent id -> sub-agent role, working folder
 * -> local cwd for attribution, time.updated -> recency. Dropped, never kept or logged: titles, permission actions/resources/messages,
 * form fields, models, costs, tokens, metadata, everything else. No message, diff, prompt, shell, pty, fs or POST route is reachable.
 */
import { ADAPTER_API_VERSION, safeErrorCode, type Adapter, type AdapterContext, type AdapterManifest, type DetectEnv, type Detection, type Observation } from './api.ts';

export const OPENCODE_ALLOW_V1 = ['/session/status', '/session'] as const;
export const OPENCODE_ALLOW_V2 = ['/api/session/active', '/api/session', '/api/permission/request', '/api/form'] as const;
export const OPENCODE_ALLOW = [...OPENCODE_ALLOW_V1, ...OPENCODE_ALLOW_V2] as const;
export const OPENCODE_DEFAULT_PORT = 4096;
const ACTIVE_MS = 30 * 60_000;
const ID_OK = /^[0-9A-Za-z_-]{1,80}$/;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

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

/** v2: `{ data: { id: { type } } }` and `{ data: [ { id, ... } ] }`. Returns the ids reported as running and the session list. */
export function verifyOpencodeV2Shape(activeBody: string, listBody: string): { running: Set<string>; list: Record<string, unknown>[] } | null {
  const a = parse(activeBody); const l = parse(listBody);
  if (!isObj(a) || !isObj(a.data) || !isObj(l) || !Array.isArray(l.data)) return null;
  const running = new Set<string>();
  for (const [k, v] of Object.entries(a.data)) {
    if (!isObj(v) || typeof v.type !== 'string') return null;
    if (v.type === 'running') running.add(k);
  }
  const list = l.data.filter(isObj);
  if (list.length !== l.data.length || !list.slice(0, 50).every((o) => typeof o.id === 'string')) return null;
  return { running, list };
}

/** v2 `permission/request` and `form` lists: only the session ids that are waiting. Everything else in the items is ignored. */
export function verifyOpencodePending(body: string): Set<string> | null {
  const b = parse(body);
  if (!isObj(b) || !Array.isArray(b.data)) return null;
  const out = new Set<string>();
  for (const x of b.data) {
    if (!isObj(x) || typeof x.sessionID !== 'string') return null;
    out.add(x.sessionID);
  }
  return out;
}

/** The exact 401 a v2 server sends before it will talk: how we know whose port this is without any credential. */
export function isOpencodeAuthRequired(body: string): boolean {
  const b = parse(body);
  return isObj(b) && b._tag === 'UnauthorizedError';
}

interface Row { id: string; status: 'working' | 'idle' | 'blocked'; live: boolean; parent: string | null; cwd: string | null; updated: number | null }
type Outcome = { t: 'ok'; rows: Row[]; ids: Set<string> } | { t: 'auth' } | { t: 'shape' } | { t: 'status' };
interface Seen { sig: string; lastEmit: number }

export class OpenCodeAdapter implements Adapter {
  readonly manifest: AdapterManifest = {
    id: 'opencode', apiVersion: ADAPTER_API_VERSION, version: '1.0.0', platforms: ['win32', 'darwin', 'linux'],
    reads: [
      { kind: 'loopback-http', target: 'GET /api/session/active', keeps: 'OpenCode 2.x: which session ids are running' },
      { kind: 'loopback-http', target: 'GET /api/session', keeps: 'OpenCode 2.x: session id, parent link, working folder (local only), last-updated time. Titles, models, costs, tokens and metadata are dropped.' },
      { kind: 'loopback-http', target: 'GET /api/permission/request', keeps: 'OpenCode 2.x: only the session ids that wait for an approval ("blocked"). The requested action, resources and message are never kept.' },
      { kind: 'loopback-http', target: 'GET /api/form', keeps: 'OpenCode 2.x: only the session ids that wait for an answer ("blocked"). The questions are never kept.' },
      { kind: 'loopback-http', target: 'GET /session/status', keeps: 'OpenCode 1.x: session ids and idle/busy/retry state' },
      { kind: 'loopback-http', target: 'GET /session', keeps: 'OpenCode 1.x: session id, parent link, working folder (local only), last-updated time. Titles are dropped.' },
      { kind: 'env', target: 'OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME)', keeps: 'Optional. Only if you set it in the agent\'s environment: used as the HTTP password for OpenCode\'s own loopback server, which requires one in 2.x. Sent only to that server after it identifies itself; never stored, logged or shown. OpenCode\'s own files and credential store are never read.' },
    ],
    capabilities: { state: true, toolCategory: false, errors: false, subagents: true, tokens: false, hierarchy: true },
    upstream: { name: 'OpenCode', tested: 'v2.0.21 OpenAPI document and live responses of an empty private server (routes, wrapper shape, 401 behaviour); 1.x docs only', verification: 'documented' },
    summary: 'OpenCode sessions through its local server (`opencode serve`; default port 4096; 2.x needs its server password in OPENCODE_SERVER_PASSWORD).',
  };
  private readonly seen = new Map<string, Seen>();
  private readonly reobserveMs: number;
  private mode: 'v1' | 'v2' = 'v2';
  private sendAuth = false;
  constructor(reobserveMs = 120_000) { this.reobserveMs = reobserveMs; }

  httpAuth(env: Record<string, string | undefined>): { user: string; password: string } | null {
    const password = env.OPENCODE_SERVER_PASSWORD;
    if (typeof password !== 'string' || password.length === 0 || password.length > 256) return null;
    const u = env.OPENCODE_SERVER_USERNAME;
    return { user: typeof u === 'string' && /^[\x21-\x39\x3b-\x7e]{1,64}$/.test(u) ? u : 'opencode', password };
  }

  async detect(env: DetectEnv): Promise<Detection> {
    const port = env.settings.port ?? OPENCODE_DEFAULT_PORT;
    const probe = (path: string) => env.probe([...OPENCODE_ALLOW], port, path, env.settings.host);
    const v2a = await probe('/api/session/active');
    if (v2a && v2a.status === 401 && isOpencodeAuthRequired(v2a.body)) {
      return { found: true, confidence: 'high', note: `OpenCode 2.x server on 127.0.0.1:${port} wants its password: put it in OPENCODE_SERVER_PASSWORD in the agent's environment` };
    }
    if (v2a && v2a.status === 200) {
      const v2b = await probe('/api/session');
      if (v2b && v2b.status === 200 && verifyOpencodeV2Shape(v2a.body, v2b.body)) return { found: true, confidence: 'high', note: `OpenCode 2.x verified on 127.0.0.1:${port}` };
    }
    const a = await probe('/session/status');
    const b = a && a.status === 200 ? await probe('/session') : null;
    if (a && b && a.status === 200 && b.status === 200) {
      return verifyOpencodeShape(a.body, b.body)
        ? { found: true, confidence: 'high', note: `OpenCode 1.x verified on 127.0.0.1:${port}` }
        : { found: false, confidence: 'high', note: `something else is listening on 127.0.0.1:${port}; ignored` };
    }
    if (v2a && v2a.status === 200) return { found: false, confidence: 'high', note: `something else is listening on 127.0.0.1:${port}; ignored` };
    return env.hasCommand('opencode') ? { found: true, confidence: 'low', note: 'installed; no local server found (run `opencode serve`, or set adapters.opencode.port)' } : { found: false, confidence: 'high' };
  }

  /** GET; if the server proves it is OpenCode with its 401, repeat once with the user's password (when there is one). */
  private async get(ctx: AdapterContext, path: string, maxBytes?: number): Promise<{ status: number; body: string }> {
    const opts = maxBytes ? { maxBytes } : {};
    const r = await ctx.http.get(path, { ...opts, auth: this.sendAuth });
    if (r.status === 401 && !this.sendAuth && isOpencodeAuthRequired(r.body)) {
      const again = await ctx.http.get(path, { ...opts, auth: true });
      if (again.status !== 401) this.sendAuth = true;
      return again;
    }
    return r;
  }

  private async readV1(ctx: AdapterContext): Promise<Outcome> {
    const a = await this.get(ctx, '/session/status');
    if (a.status === 401 && isOpencodeAuthRequired(a.body)) return { t: 'auth' };
    if (a.status !== 200) return { t: 'status' };
    const b = await this.get(ctx, '/session', 2 * 1024 * 1024);
    if (b.status !== 200) return { t: 'status' };
    const shape = verifyOpencodeShape(a.body, b.body);
    if (!shape) return { t: 'shape' };
    const rows: Row[] = [];
    for (const s of shape.list) {
      const id = String(s.id);
      const st = shape.status[id];
      const time = s.time as { updated?: unknown } | undefined;
      rows.push({
        id, status: st === 'busy' || st === 'retry' ? 'working' : 'idle', live: st !== undefined && st !== 'idle',
        parent: typeof s.parentID === 'string' ? s.parentID : null,
        cwd: typeof s.directory === 'string' ? s.directory : null,
        updated: typeof time?.updated === 'number' ? time.updated : null,
      });
    }
    return { t: 'ok', rows, ids: new Set(shape.list.map((s) => String(s.id))) };
  }

  private async readV2(ctx: AdapterContext): Promise<Outcome> {
    const a = await this.get(ctx, '/api/session/active');
    if (a.status === 401 && isOpencodeAuthRequired(a.body)) return { t: 'auth' };
    if (a.status !== 200) return { t: 'status' };
    const b = await this.get(ctx, '/api/session', 2 * 1024 * 1024);
    if (b.status === 401 && isOpencodeAuthRequired(b.body)) return { t: 'auth' };
    if (b.status !== 200) return { t: 'status' };
    const shape = verifyOpencodeV2Shape(a.body, b.body);
    if (!shape) return { t: 'shape' };
    // Best-effort "waiting for the owner" signals; a failure here never fails the poll.
    const waiting = new Set<string>();
    for (const path of ['/api/permission/request', '/api/form']) {
      try {
        const r = await this.get(ctx, path, 512 * 1024);
        const p = r.status === 200 ? verifyOpencodePending(r.body) : null;
        if (p) for (const id of p) waiting.add(id);
      } catch { /* ignore */ }
    }
    const rows: Row[] = [];
    const ids = new Set<string>();
    for (const s of shape.list) {
      const id = String(s.id);
      ids.add(id);
      const time = s.time as { updated?: unknown } | undefined;
      const loc = s.location as { directory?: unknown } | undefined;
      const blocked = waiting.has(id);
      const running = shape.running.has(id);
      rows.push({
        id, status: blocked ? 'blocked' : running ? 'working' : 'idle', live: blocked || running,
        parent: typeof s.parentID === 'string' ? s.parentID : null,
        cwd: typeof loc?.directory === 'string' ? loc.directory : null,
        updated: typeof time?.updated === 'number' ? time.updated : null,
      });
    }
    // Running or waiting sessions the (possibly paged) list did not include: state is known, folder is not.
    for (const id of new Set([...shape.running, ...waiting])) {
      if (ids.has(id)) continue;
      rows.push({ id, status: waiting.has(id) ? 'blocked' : 'working', live: true, parent: null, cwd: null, updated: null });
    }
    return { t: 'ok', rows, ids };
  }

  async poll(ctx: AdapterContext, now: Date): Promise<Observation[]> {
    const nowMs = now.getTime();
    let result: Outcome;
    try {
      const first = this.mode;
      const second = first === 'v2' ? 'v1' : 'v2';
      const tryMode = (m: 'v1' | 'v2'): Promise<Outcome> => (m === 'v2' ? this.readV2(ctx) : this.readV1(ctx));
      let r1 = await tryMode(first);
      let used = first;
      if (r1.t !== 'ok' && r1.t !== 'auth') {
        const r2 = await tryMode(second);
        if (r2.t === 'ok' || r2.t === 'auth') { r1 = r2; used = second; }
        else if (r1.t === 'status' && r2.t === 'shape') r1 = r2;
      }
      result = r1;
      if (result.t === 'ok') this.mode = used;
    } catch (e) {
      if (safeErrorCode(e) !== 'ECONNREFUSED') ctx.log('unreachable');
      return this.seen.size > 0 ? [{ kind: 'adapter.health', state: 'degraded', code: 'unreachable' }] : [];
    }
    if (result.t === 'status') return [{ kind: 'adapter.health', state: 'degraded', code: 'unreachable' }];
    if (result.t === 'auth') { ctx.log('policy_denied'); return [{ kind: 'adapter.health', state: 'degraded', code: 'policy_denied' }]; }
    if (result.t === 'shape') { ctx.log('unexpected_shape'); return [{ kind: 'adapter.health', state: 'unsupported_version', code: 'unexpected_shape' }]; }
    const out: Observation[] = [{ kind: 'adapter.health', state: 'ok', code: 'none' }];
    const present = new Set<string>();
    let n = 0;
    for (const s of result.rows) {
      const recent = s.updated !== null ? nowMs - s.updated <= ACTIVE_MS : false;
      if (!ID_OK.test(s.id) || (!recent && !s.live) || n >= 100) continue;
      n++;
      const key = `opencode:${s.id}`;
      present.add(key);
      const parent = s.parent !== null && result.ids.has(s.parent) && ID_OK.test(s.parent) ? s.parent : null;
      const cwd = s.cwd !== null && s.cwd.length > 0 && s.cwd.length <= 1024 ? s.cwd : null;
      const projectId = await ctx.attribute(cwd, nowMs);
      const sig = `${s.status}|${parent ?? ''}|${projectId ?? ''}`;
      const prev = this.seen.get(key);
      if (!prev || prev.sig !== sig || nowMs - prev.lastEmit >= this.reobserveMs) {
        this.seen.set(key, { sig, lastEmit: nowMs });
        out.push({
          kind: 'session', key, tool: 'opencode', harness: 'unknown', status: s.status, projectId, certainty: 'observed',
          correlate: [{ type: 'opencode-session', id: s.id }],
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
