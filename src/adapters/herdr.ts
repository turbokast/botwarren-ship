/**
 * Herdr adapter (https://herdr.dev, session multiplexer for coding agents). READ-ONLY: the only JSON-RPC methods this
 * client can send are `agent.list` and `ping` (enforced in code and tested); `agent.read`, `pane.read`, `agent.prompt`,
 * `pane.send_*`, `session.snapshot` (may contain secrets, per Herdr's docs) are unreachable.
 *
 * Socket resolution (Herdr docs: --session flag, HERDR_SOCKET_PATH, HERDR_SESSION, default), plus the legacy
 * HERDR_SOCKET this project used before:
 *   1. HERDR_SOCKET_PATH                         (documented)
 *   2. HERDR_SESSION=<name> -> ~/.config/herdr/sessions/<name>/herdr.sock   (documented)
 *   3. HERDR_SOCKET                              (legacy fallback)
 *   4. ~/.config/herdr/herdr.sock                (default)
 *   5. every ~/.config/herdr/sessions/<name>/herdr.sock found (named sessions)        [layout per docs]
 * Windows: Herdr uses a NAMED PIPE whose name is NOT documented. UNVERIFIED: we connect only when HERDR_SOCKET_PATH
 * names a pipe (\\.\pipe\...) explicitly; otherwise the adapter reports `unsupported_platform` instead of guessing a
 * pipe name (a wrong guess could talk to another program).
 *
 * Emitted: agent kind (enum), pane status (enum), a hashed-or-id session key, the pane cwd (local only, for project
 * attribution) and a work category classified locally from the pane title (the title itself is dropped at once).
 */
import { createConnection, type Socket } from 'node:net';
import { join, posix, win32 } from 'node:path';
import { z } from 'zod';
import { classifyTitle } from '../readers/sessionlog.ts';
import { ADAPTER_API_VERSION, PolicyError, safeErrorCode, type Adapter, type AdapterContext, type AdapterManifest, type DetectEnv, type Detection, type Observation, type ToolId } from './api.ts';
import type { Host } from '../paths.ts';

export const HERDR_ALLOWED_METHODS: ReadonlySet<string> = new Set(['agent.list', 'ping']);

const HerdrAgent = z.object({
  agent: z.string().max(64).nullable().optional(),
  agent_status: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']),
  agent_session: z.object({ agent: z.string().max(64), value: z.string().max(200) }).passthrough().nullable().optional(),
  cwd: z.string().max(1024).nullable().optional(),
  pane_id: z.string().max(200),
  terminal_id: z.string().max(200).optional(),
  terminal_title_stripped: z.string().max(2000).nullable().optional(),
}).passthrough();
type HerdrAgent = z.infer<typeof HerdrAgent>;

const NAME_OK = /^[A-Za-z0-9._-]{1,64}$/;
const WIN_PIPE = /^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,120}$/;

export interface HerdrTarget { name: string; path: string }

export function herdrBase(host: Host): string {
  if (host.platform === 'win32') return win32.join(host.env.APPDATA ?? win32.join(host.home, 'AppData', 'Roaming'), 'herdr');
  return posix.join(host.env.XDG_CONFIG_HOME || posix.join(host.home, '.config'), 'herdr');
}

/** Candidate sockets, most specific first. `namedSessions`: directory names found under <base>/sessions. */
export function herdrTargets(host: Host, namedSessions: string[] = []): HerdrTarget[] {
  const out: HerdrTarget[] = [];
  const add = (name: string, path: string) => { if (!out.some((t) => t.path === path) && out.length < 8) out.push({ name, path }); };
  const env = host.env;
  if (host.platform === 'win32') {
    const p = env.HERDR_SOCKET_PATH;
    if (p && WIN_PIPE.test(p)) add('default', p); // UNVERIFIED: named pipe name is undocumented, explicit only
    return out;
  }
  const base = herdrBase(host);
  const join_ = posix.join;
  if (env.HERDR_SOCKET_PATH && env.HERDR_SOCKET_PATH.startsWith('/') && env.HERDR_SOCKET_PATH.length < 1024) add('env', env.HERDR_SOCKET_PATH);
  if (env.HERDR_SESSION && NAME_OK.test(env.HERDR_SESSION)) add(env.HERDR_SESSION, join_(base, 'sessions', env.HERDR_SESSION, 'herdr.sock'));
  if (env.HERDR_SOCKET && env.HERDR_SOCKET.startsWith('/') && env.HERDR_SOCKET.length < 1024) add('env-legacy', env.HERDR_SOCKET);
  add('default', join_(base, 'herdr.sock'));
  for (const n of namedSessions) if (NAME_OK.test(n)) add(n, join_(base, 'sessions', n, 'herdr.sock'));
  return out;
}

/** Newline-delimited JSON-RPC over a socket, restricted to read-only methods. */
export class HerdrRpc {
  private sock: Socket | undefined;
  private buf = '';
  private readonly waiters = new Map<string, (v: { result?: unknown; error?: unknown }) => void>();
  private n = 0;
  readonly path: string;
  constructor(path: string) { this.path = path; }

  private connect(): Promise<Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    return new Promise((resolve, reject) => {
      const s = createConnection(this.path);
      s.setEncoding('utf8');
      s.once('connect', () => { this.sock = s; resolve(s); });
      s.once('error', (e) => { this.sock = undefined; reject(e); });
      s.on('close', () => { this.sock = undefined; for (const w of this.waiters.values()) w({ error: 'closed' }); this.waiters.clear(); });
      s.on('data', (chunk: string) => {
        this.buf += chunk;
        if (this.buf.length > 8_000_000) { this.buf = ''; s.destroy(); return; }
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
          try { const m = JSON.parse(line) as { id?: string; result?: unknown; error?: unknown }; if (m.id) { this.waiters.get(m.id)?.(m); this.waiters.delete(m.id); } } catch { /* ignore malformed line */ }
        }
      });
    });
  }

  async call(method: string, timeoutMs = 4000): Promise<unknown> {
    if (!HERDR_ALLOWED_METHODS.has(method)) throw new PolicyError('method not allowed');
    const s = await this.connect();
    const id = `bw-${++this.n}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error('timeout')); }, timeoutMs);
      this.waiters.set(id, (m) => { clearTimeout(t); if (m.error) reject(new Error('rpc error')); else resolve(m.result); });
      s.write(JSON.stringify({ id, method, params: {} }) + '\n');
    });
  }

  async listAgents(): Promise<HerdrAgent[]> {
    const r = (await this.call('agent.list')) as { agents?: unknown } | null;
    if (!r || !Array.isArray(r.agents)) throw new Error('shape');
    return r.agents.flatMap((a) => { const p = HerdrAgent.safeParse(a); return p.success ? [p.data] : []; });
  }
  close(): void { this.sock?.destroy(); }
}

const TOOL: Record<string, ToolId> = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', gemini: 'gemini-cli', aider: 'aider', muse: 'muse' };
const ID_OK = /^[0-9A-Za-z-]{8,64}$/;

interface Seen { sig: string; lastEmit: number; targetName: string }

export class HerdrAdapter implements Adapter {
  readonly manifest: AdapterManifest;
  private readonly rpcs = new Map<string, { rpc: HerdrRpc; retryAt: number; fails: number }>();
  private readonly seen = new Map<string, Seen>();
  private readonly base: string;

  private readonly reobserveMs: number;
  constructor(host: Host, reobserveMs = 120_000) {
    this.reobserveMs = reobserveMs;
    this.base = herdrBase(host);
    this.manifest = {
      id: 'herdr', apiVersion: ADAPTER_API_VERSION, version: '1.0.0', platforms: ['darwin', 'linux', 'win32'],
      reads: [
        { kind: 'dir', target: this.base, keeps: 'only the names of named-session folders, to find their sockets' },
        { kind: host.platform === 'win32' ? 'named-pipe' : 'unix-socket', target: `${this.base}${host.platform === 'win32' ? '' : '/herdr.sock'} (+ named sessions)`, keeps: 'JSON-RPC agent.list and ping only: agent kind, status, session id, working folder, pane id. Never pane output, prompts or snapshots.' },
      ],
      capabilities: { state: true, toolCategory: false, errors: false, subagents: false, tokens: false, hierarchy: false },
      upstream: { name: 'Herdr', tested: '0.9.4 (docs); protocol 22 collector fixtures', verification: 'documented' },
      summary: 'Agents running in Herdr panes (status, blocked-for-approval), including named sessions.',
    };
  }

  private namedSessions(ctx: { fs: AdapterContext['fs'] }): string[] {
    return ctx.fs.list(join(this.base, 'sessions')).filter((e) => e.isDirectory).map((e) => e.name).slice(0, 16);
  }

  async detect(env: DetectEnv): Promise<Detection> {
    if (env.host.platform === 'win32') {
      const t = herdrTargets(env.host);
      return t.length ? { found: true, confidence: 'low', note: 'Windows named pipe given explicitly in HERDR_SOCKET_PATH (UNVERIFIED)' }
        : { found: false, confidence: 'low', note: 'Windows: Herdr uses a named pipe with an undocumented name (UNVERIFIED); set HERDR_SOCKET_PATH to enable' };
    }
    const fs = env.fs([this.base]);
    const named = fs.list(join(this.base, 'sessions')).filter((e) => e.isDirectory).map((e) => e.name);
    const t = herdrTargets(env.host, named);
    const sockPresent = t.some((x) => { try { return env.exists(x.path); } catch { return false; } });
    if (sockPresent) return { found: true, confidence: 'high' };
    return env.hasCommand('herdr') ? { found: true, confidence: 'medium', note: 'herdr is installed but not running' } : { found: false, confidence: 'high' };
  }

  async poll(ctx: AdapterContext, now: Date): Promise<Observation[]> {
    const nowMs = now.getTime();
    if (ctx.host.platform === 'win32' && herdrTargets(ctx.host).length === 0) return [{ kind: 'adapter.health', state: 'degraded', code: 'unsupported_platform' }];
    const targets = herdrTargets(ctx.host, ctx.host.platform === 'win32' ? [] : this.namedSessions(ctx));
    const out: Observation[] = [];
    const present = new Set<string>();
    const okTargets = new Set<string>();
    let anyOk = false;
    for (const t of targets) {
      let st = this.rpcs.get(t.path);
      if (!st) { st = { rpc: new HerdrRpc(t.path), retryAt: 0, fails: 0 }; this.rpcs.set(t.path, st); }
      if (nowMs < st.retryAt) continue;
      let agents: HerdrAgent[];
      try { agents = await st.rpc.listAgents(); st.fails = 0; } catch (e) {
        st.rpc.close();
        st.fails++; st.retryAt = nowMs + Math.min(30_000, 1000 * 2 ** Math.min(st.fails, 5)); // reconnect with backoff
        const code = safeErrorCode(e);
        if (code !== 'ENOENT' && code !== 'ECONNREFUSED') ctx.log('unreachable', st.fails);
        continue;
      }
      anyOk = true; okTargets.add(t.name);
      for (const a of agents) {
        if (!a.agent) continue;
        const o = await this.observe(ctx, t, a, nowMs);
        present.add(o.key);
        if (this.shouldEmit(o, t.name, nowMs)) out.push(o.obs);
      }
    }
    // sessions vanished from a snapshot we DID get -> ended. While Herdr is unreachable nothing is ended.
    for (const [key, s] of [...this.seen]) {
      if (present.has(key) || !okTargets.has(s.targetName)) continue;
      this.seen.delete(key);
      out.push({ kind: 'session.ended', key, reason: 'not_seen_in_snapshot' });
    }
    if (targets.length > 0 && !anyOk && this.seen.size > 0) out.push({ kind: 'adapter.health', state: 'degraded', code: 'unreachable' });
    return out;
  }

  private async observe(ctx: AdapterContext, t: HerdrTarget, a: HerdrAgent, nowMs: number): Promise<{ key: string; obs: Observation }> {
    const name = (a.agent ?? '').toLowerCase();
    const tool: ToolId = TOOL[name] ?? 'other';
    const value = a.agent_session?.value;
    const sessionAgent = (a.agent_session?.agent ?? name).toLowerCase();
    const correlate: { type: 'claude-session' | 'codex-session' | 'herdr-pane'; id: string }[] = [{ type: 'herdr-pane', id: `${t.name}/${a.pane_id}` }];
    let key: string;
    if (value && ID_OK.test(value) && (sessionAgent === 'claude' || sessionAgent === 'codex')) {
      key = `${sessionAgent}:${value}`;
      correlate.push({ type: sessionAgent === 'claude' ? 'claude-session' : 'codex-session', id: value });
    } else {
      key = `pane:${t.name === 'default' ? '' : `${t.name}:`}${a.terminal_id ?? a.pane_id}`;
    }
    const category = classifyTitle(a.terminal_title_stripped); // the title is classified here and dropped
    const projectId = await ctx.attribute(a.cwd ?? null, nowMs);
    const harness = name === 'claude' ? 'claude' : name === 'codex' ? 'codex' : name === 'muse' ? 'muse' : 'unknown';
    return {
      key,
      obs: {
        kind: 'session', key, correlate, tool, harness, status: a.agent_status, role: 'main', projectId, certainty: 'observed',
        workCategory: category, local: a.cwd ? { cwd: a.cwd } : {},
      },
    };
  }

  private shouldEmit(o: { key: string; obs: Observation }, targetName: string, nowMs: number): boolean {
    const s = o.obs as { status?: string; projectId?: string | null; workCategory?: string };
    const sig = `${s.status}|${s.projectId ?? ''}|${s.workCategory ?? ''}`;
    const prev = this.seen.get(o.key);
    if (prev && prev.sig === sig && nowMs - prev.lastEmit < this.reobserveMs) return false;
    this.seen.set(o.key, { sig, lastEmit: nowMs, targetName });
    return true;
  }

  async stop(): Promise<void> { for (const { rpc } of this.rpcs.values()) rpc.close(); this.rpcs.clear(); }
}
