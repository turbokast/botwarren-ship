/**
 * Ninox adapter (https://github.com/Made-by-Moonlight/ninox: Rust fleet supervisor for coding agents, macOS + Linux).
 *
 * READ-ONLY, hard allowlist: exactly `GET /api/v1/sessions` and `GET /api/v1/events` (SSE) on 127.0.0.1:<port>
 * (default 8080, `adapters.ninox.port`, or `port` in Ninox's own config.toml). NEVER reachable from this adapter, enforced
 * by the loopback policy and tested: DELETE /api/v1/sessions/:id (mutating), /:id/diff (source code), /:id/terminal
 * (raw terminal WebSocket, keystroke injection), /api/v1/orchestrators, /api/brain/* and the SQLite store.
 *
 * Port 8080 is shared by many tools, so the response SHAPE is verified before anything is trusted: a JSON array of
 * objects with string `id`, `status`, `activity`, `agent_type` (field names from Ninox's types.rs, read 2026-10-14;
 * UNVERIFIED against a live install, see docs/ARCHITECTURE.md). Anything else -> `unexpected_shape`,
 * no observations.
 *
 * Kept: status/activity -> our status enum, agent_type -> tool, orchestrator link -> role/parent, context_used_pct ->
 * 4-step bucket, model -> family, claude_session_id -> CORRELATION ONLY (joins the Claude log adapter's session),
 * workspace_path -> local cwd for attribution. Dropped always: name, repo, summary, activity_note, catalogue_path,
 * pr_number/pr_id, pid, cost_usd, gate_status, machine_id and every unknown field. PR/CI state is kept as a local-only
 * lifecycle enum and is never published as CI telemetry.
 */
import { posix, win32 } from 'node:path';
import { bucketContext } from '../vendor/core/contract.ts';
import { modelFamily } from '../readers/subagents.ts';
import { ADAPTER_API_VERSION, safeErrorCode, type Adapter, type AdapterContext, type AdapterManifest, type AdapterSettings, type DetectEnv, type Detection, type Local, type Observation, type ToolId } from './api.ts';
import type { Host } from '../paths.ts';

export const NINOX_ALLOW = ['/api/v1/sessions', '/api/v1/events'] as const;
const DEFAULT_PORT = 8080;
const WAKE_TYPES = new Set(['session_updated', 'worker_spawned', 'worker_done', 'orchestrator_spawned', 'orchestrator_removed', 'ci_update', 'pr_event']);
const TERMINAL = new Set(['done', 'terminated', 'interrupted']);
const LIFECYCLE = new Set(['spawning', 'working', 'pr_open', 'ci_failed', 'review_pending', 'mergeable', 'done']);
const MAX_SESSIONS = 200;

export function ninoxConfigPath(host: Host): string {
  const e = host.env.NINOX_CONFIG;
  if (e && (e.startsWith('/') || /^[A-Za-z]:[\\/]/.test(e)) && e.length < 1024) return e;
  if (host.platform === 'darwin') return posix.join(host.home, 'Library', 'Application Support', 'ninox', 'config.toml');
  if (host.platform === 'win32') return win32.join(host.env.APPDATA ?? win32.join(host.home, 'AppData', 'Roaming'), 'ninox', 'config.toml');
  return posix.join(host.env.XDG_CONFIG_HOME || posix.join(host.home, '.config'), 'ninox', 'config.toml');
}

/** Only the top-level `port = N` of Ninox's config.toml is read (first 64 KiB). */
export function parsePortFromToml(text: string): number | null {
  for (const raw of text.slice(0, 65536).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) return null; // a table starts: top-level keys are over
    const m = /^port\s*=\s*(\d{4,5})\s*(#.*)?$/.exec(line);
    if (m) { const n = Number(m[1]); return n >= 1024 && n <= 65535 ? n : null; }
  }
  return null;
}

/** Port precedence: adapters.ninox.port, then Ninox's own config.toml, then 8080. */
export function resolveNinoxPort(host: Host, settings: AdapterSettings, readHead: (p: string, n: number) => Buffer | null): number {
  if (settings.port) return settings.port;
  const b = readHead(ninoxConfigPath(host), 65536);
  return (b ? parsePortFromToml(b.toString('utf8')) : null) ?? DEFAULT_PORT;
}

/** Returns the session objects if the body has Ninox's shape, 'empty' for an empty list, null otherwise. */
export function verifyNinoxShape(body: string): Record<string, unknown>[] | 'empty' | null {
  let v: unknown;
  try { v = JSON.parse(body); } catch { return null; }
  const arr = Array.isArray(v) ? v : (v && typeof v === 'object' && Array.isArray((v as { sessions?: unknown }).sessions) ? (v as { sessions: unknown[] }).sessions : null);
  if (!arr) return null;
  if (arr.length === 0) return 'empty';
  const objs = arr.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x));
  if (objs.length !== arr.length) return null;
  const ok = objs.slice(0, 50).every((o) => typeof o.id === 'string' && typeof o.status === 'string' && typeof o.activity === 'string' && typeof o.agent_type === 'string');
  return ok ? objs : null;
}

function toolOf(agentType: string): { tool: ToolId; harness: 'claude' | 'codex' | 'unknown' } {
  const t = agentType.toLowerCase();
  if (t.startsWith('claude')) return { tool: 'claude-code', harness: 'claude' };
  if (t.startsWith('codex')) return { tool: 'codex', harness: 'codex' };
  if (t.startsWith('opencode')) return { tool: 'opencode', harness: 'unknown' };
  if (t.startsWith('aider')) return { tool: 'aider', harness: 'unknown' };
  if (t.startsWith('freebuff')) return { tool: 'freebuff', harness: 'unknown' };
  return { tool: 'other', harness: 'unknown' };
}

function statusOf(activity: string, status: string): 'working' | 'idle' | 'blocked' | 'unknown' {
  if (activity === 'working' || activity === 'idle' || activity === 'blocked') return activity;
  if (status === 'spawning' || status === 'working') return 'working';
  if (status === 'pr_open' || status === 'ci_failed' || status === 'review_pending' || status === 'mergeable') return 'idle';
  return 'unknown';
}

const ID_OK = /^[0-9A-Za-z_-]{1,64}$/;
const UUIDISH = /^[0-9a-f-]{36}$/i;

interface Seen { sig: string; lastEmit: number; ctx: string }

export class NinoxAdapter implements Adapter {
  readonly manifest: AdapterManifest;
  private readonly seen = new Map<string, Seen>();
  private abort: AbortController | null = null;
  private streaming = false;
  private stopped = false;

  private readonly reobserveMs: number;
  constructor(host: Host, reobserveMs = 120_000) {
    this.reobserveMs = reobserveMs;
    this.manifest = {
      id: 'ninox', apiVersion: ADAPTER_API_VERSION, version: '1.0.0', platforms: ['darwin', 'linux'],
      reads: [
        { kind: 'file', target: ninoxConfigPath(host), keeps: 'only the numeric `port` setting' },
        { kind: 'loopback-http', target: 'GET /api/v1/sessions', keeps: 'session id, status, activity, agent type, orchestrator link, model family, context %, Claude session id, workspace path (local only). Names, repo, summaries, notes, costs and PR numbers are dropped.' },
        { kind: 'loopback-http', target: 'GET /api/v1/events', keeps: 'only the event type, as a hint to poll sooner; payloads are never parsed' },
      ],
      capabilities: { state: true, toolCategory: false, errors: false, subagents: false, tokens: true, hierarchy: true },
      upstream: { name: 'Ninox', tested: 'v0.34.0 source (types.rs, routes/*.rs); no live recording', verification: 'unverified' },
      summary: 'Ninox orchestrators and workers (read-only local API on 127.0.0.1), merged with the Claude session they run.',
    };
  }

  async detect(env: DetectEnv): Promise<Detection> {
    if (env.host.platform !== 'darwin' && env.host.platform !== 'linux') return { found: false, confidence: 'high', note: 'Ninox does not support Windows' };
    const port = resolveNinoxPort(env.host, env.settings, (p, n) => env.fs([p]).readHead(p, n));
    const r = await env.probe(['/api/v1/sessions'], port, '/api/v1/sessions', env.settings.host);
    if (r && r.status === 200) {
      const shape = verifyNinoxShape(r.body);
      if (shape === 'empty') return { found: true, confidence: 'medium', note: `answers on 127.0.0.1:${port} with no sessions yet (shape not verifiable)` };
      if (shape) return { found: true, confidence: 'high', note: `verified on 127.0.0.1:${port}` };
      return { found: false, confidence: 'high', note: `something else is listening on 127.0.0.1:${port} (not Ninox's API shape); ignored` };
    }
    const installed = env.hasCommand('ninox') || env.hasCommand('nx') || env.exists(ninoxConfigPath(env.host));
    return installed ? { found: true, confidence: 'medium', note: 'installed, daemon not running' } : { found: false, confidence: 'high' };
  }

  async poll(ctx: AdapterContext, now: Date): Promise<Observation[]> {
    const nowMs = now.getTime();
    let body: string;
    try {
      const r = await ctx.http.get('/api/v1/sessions', { maxBytes: 1024 * 1024 });
      if (r.status !== 200) return [{ kind: 'adapter.health', state: 'degraded', code: 'unreachable' }];
      body = r.body;
    } catch (e) {
      if (safeErrorCode(e) !== 'ECONNREFUSED') ctx.log('unreachable');
      return this.seen.size > 0 ? [{ kind: 'adapter.health', state: 'degraded', code: 'unreachable' }] : []; // never end sessions while the feed is down
    }
    const shape = verifyNinoxShape(body);
    if (shape === null) { ctx.log('unexpected_shape'); return [{ kind: 'adapter.health', state: 'unsupported_version', code: 'unexpected_shape' }]; }
    this.ensureStream(ctx);
    const rows = shape === 'empty' ? [] : shape.slice(0, MAX_SESSIONS);
    const live = new Set(rows.filter((r) => !TERMINAL.has(String(r.status))).map((r) => String(r.id)));
    const out: Observation[] = [{ kind: 'adapter.health', state: 'ok', code: 'none' }];
    const present = new Set<string>();
    for (const r of rows) {
      const id = String(r.id);
      if (!ID_OK.test(id) || !live.has(id)) continue;
      const key = `ninox:${id}`;
      present.add(key);
      const status = String(r.status);
      const { tool, harness } = toolOf(String(r.agent_type));
      const st = statusOf(String(r.activity), status);
      const orch = typeof r.orchestrator_id === 'string' && ID_OK.test(r.orchestrator_id) && live.has(r.orchestrator_id) && r.orchestrator_id !== id ? r.orchestrator_id : null;
      const cs = typeof r.claude_session_id === 'string' && UUIDISH.test(r.claude_session_id) ? r.claude_session_id : null;
      const cwd = typeof r.workspace_path === 'string' && r.workspace_path.length > 0 && r.workspace_path.length <= 1024 ? r.workspace_path : null;
      const model = tool === 'codex' ? 'gpt' : typeof r.model === 'string' ? modelFamily(r.model) : undefined;
      const pct = typeof r.context_used_pct === 'number' ? r.context_used_pct : null;
      const fill = pct !== null && pct >= 0 && pct <= 100 ? bucketContext(pct / 100) : 'unknown';
      const lifecycle: Local['lifecycle'] = LIFECYCLE.has(status) ? (status as Local['lifecycle']) : 'other';
      const projectId = await ctx.attribute(cwd, nowMs);
      const sig = `${st}|${tool}|${orch ?? ''}|${model ?? ''}|${projectId ?? ''}|${lifecycle}`;
      const prev = this.seen.get(key);
      if (!prev || prev.sig !== sig || nowMs - prev.lastEmit >= this.reobserveMs) {
        out.push({
          kind: 'session', key, tool, harness, status: st, projectId, certainty: 'observed',
          correlate: [{ type: 'ninox-session', id }, ...(cs ? [{ type: 'claude-session' as const, id: cs }] : [])],
          ...(orch ? { role: 'subagent' as const, parentKey: `ninox:${orch}` } : {}),
          ...(model ? { model } : {}),
          local: { ...(cwd ? { cwd } : {}), lifecycle },
        });
      }
      const ctxPrev = prev?.ctx ?? '';
      if (fill !== 'unknown' && fill !== ctxPrev) out.push({ kind: 'activity', key, act: 'context', toolCategory: 'other', context: fill, at: now.toISOString() });
      this.seen.set(key, { sig, lastEmit: !prev || prev.sig !== sig || nowMs - prev.lastEmit >= this.reobserveMs ? nowMs : prev.lastEmit, ctx: fill === 'unknown' ? ctxPrev : fill });
    }
    for (const key of [...this.seen.keys()]) {
      if (present.has(key)) continue;
      this.seen.delete(key);
      out.push({ kind: 'session.ended', key, reason: 'unknown' });
    }
    return out;
  }

  /** SSE as a wake-up hint only; started after the first verified poll, retried with backoff. */
  private ensureStream(ctx: AdapterContext): void {
    if (this.streaming || this.stopped) return;
    this.streaming = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    void (async () => {
      let fails = 0;
      while (!signal.aborted) {
        try {
          await ctx.http.sse('/api/v1/events', (line) => {
            const m = /^\{"type":"([a-z_]{1,40})"/.exec(line); // type only: the payload is never parsed
            if (m && WAKE_TYPES.has(m[1]!)) ctx.requestPoll();
          }, signal);
          fails = 0;
        } catch { fails++; }
        if (signal.aborted) break;
        await new Promise<void>((r) => { const t = setTimeout(r, Math.min(60_000, 2000 * 2 ** Math.min(fails, 5))); t.unref(); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
      }
      this.streaming = false;
    })();
  }

  async stop(): Promise<void> { this.stopped = true; this.abort?.abort(); }
}
