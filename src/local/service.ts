/**
 * The ship agent's LOCAL service: authenticated ingest on loopback, the canonical journal, classification into the allow-listed
 * public projection, delayed publication into public.db, and the owner's local "ops room" API.
 * It listens on 127.0.0.1 only and is never reachable from the network.
 */
import { createServer, type Server } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  CanonicalEvent, ShipLook, ShipManifest, apply, emptyWorld, projectPublic, projectSessionEnded, projectMishap, projectStep, projectContext, draftIdentity, worldDigest,
  type ProjectId, type ProjectionPolicy, type WorldState,
} from '../vendor/core/contract.ts';
import { PrivateStore, PublicStoreWriter } from './stores.ts';
import { json, readBody, tokenMatches, bearer, cookie, SECURITY_HEADERS, RateLimiter, clientId } from './http.ts';

export interface PrivateConfig {
  privateDbPath: string;
  publicDbPath: string;
  ingestToken: string;
  opsToken: string;
  delaySeconds: number;
  demoMode: boolean;
  publicProjects: ProjectId[];
  now?: () => Date;
  opsHtml?: () => string;
  /** Public ship manifest (display names chosen by the ship owner). */
  shipManifest: ShipManifest;
  /** Host names (port ignored) this loopback service answers to; anything else is refused (DNS rebinding). Default 127.0.0.1, localhost, [::1]. */
  allowedHosts?: string[];
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
/** `Host` header without its port, lower-cased; null when absent or malformed. */
function hostName(h: string | undefined): string | null {
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec((h ?? '').trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Per-feed heartbeat timeout ≈ 2.5× its poll/heartbeat interval. */
const HEARTBEAT_TIMEOUT_MS: Record<string, number> = { herdr: 90_000, gitlab: 180_000, github: 400_000 };
const timeoutFor = (feed: string) => HEARTBEAT_TIMEOUT_MS[feed] ?? 180_000;
const STALE_SESSION_MS = 6 * 60_000;
const MISHAP_THROTTLE_MS = 45_000; // collector re-observes live sessions every 2 min

const IngestBody = z.object({ events: z.array(z.unknown()).max(500) });

export class PrivateService {
  readonly store: PrivateStore;
  readonly pub: PublicStoreWriter;
  world: WorldState = emptyWorld();
  /** latest private provenance per session, for the authenticated ops room only */
  private provenance: Record<string, Record<string, unknown>> = Object.create(null);
  private readonly policy: ProjectionPolicy;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => Date;
  /** ops sessions: random id → expiry (ms). The root ops token never goes into a cookie. */
  private opsSessions = new Map<string, number>();
  private readonly loginLimiter = new RateLimiter(10, 10 * 60_000);
  /** at most one public mishap per worker per MISHAP_THROTTLE_MS */
  private lastMishap = new Map<string, number>();

  readonly cfg: PrivateConfig;

  constructor(cfg: PrivateConfig) {
    this.cfg = cfg;
    this.now = cfg.now ?? (() => new Date());
    this.store = new PrivateStore(cfg.privateDbPath);
    this.pub = new PublicStoreWriter(cfg.publicDbPath);
    const salt = this.store.getSetting('pseudonym_salt')!;
    this.policy = {
      publicProjects: new Set(cfg.publicProjects),
      demoMode: cfg.demoMode,
      pseudonym: (ns, key) => createHmac('sha256', salt).update(`${ns}\0${key}`).digest('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(8, '0').slice(0, 8),
    };
    if (this.store.getSetting('delay_seconds') === undefined) this.store.setSetting('delay_seconds', String(cfg.delaySeconds));
    // replay journal into memory (deterministic order)
    for (const e of this.store.allEvents()) { apply(this.world, e); this.noteProvenance(e); }
    this.syncPublicMeta();
    this.revokeRemovedProjects();
  }

  /** Effective public manifest: configured projects + the owner's saved ship look (if any). */
  manifest(): ShipManifest {
    const base = ShipManifest.parse(this.cfg.shipManifest);
    const raw = this.store.getSetting('ship_look');
    const look = raw ? ShipLook.safeParse(JSON.parse(raw)) : null;
    return look?.success ? { ...base, look: look.data } : base;
  }

  /** Replaces the configured public manifest (e.g. owner opted in/out of real project names) and republishes it at once. Same project ids only. */
  setShipManifest(next: ShipManifest): void {
    const parsed = ShipManifest.parse(next);
    const ids = (m: ShipManifest) => m.projects.map((p) => p.id).join(',');
    if (ids(parsed) !== ids(ShipManifest.parse(this.cfg.shipManifest))) throw new Error('manifest project ids may not change');
    this.cfg.shipManifest = parsed;
    this.syncPublicMeta();
  }

  setLook(look: unknown, actor: string): ShipLook | null {
    if (look === null) { this.store.setSetting('ship_look', ''); this.store.audit(actor, 'ship_look_reset', '', this.now().toISOString()); this.syncPublicMeta(); return null; }
    const parsed = ShipLook.parse(look);
    const ids = new Set(ShipManifest.parse(this.cfg.shipManifest).projects.map((p) => p.id));
    if (parsed.modules.some((m) => !ids.has(m.project))) throw Object.assign(new Error('unknown project in look'), { status: 400 });
    this.store.setSetting('ship_look', JSON.stringify(parsed));
    this.store.audit(actor, 'ship_look_saved', `${parsed.hull}/${parsed.palette}/${parsed.decor.length} decor`, this.now().toISOString());
    this.syncPublicMeta();
    return parsed;
  }

  /** Emergency stop, from the ops room. */
  get localKill(): boolean { return this.store.getSetting('kill_switch') === 'on'; }
  /** "Pause publishing" pressed by the owner on the website (the cloud tells the agent in the publish response). */
  get remotePaused(): boolean { return this.store.getSetting('remote_pause') === 'on'; }
  /** Either one stops publication: nothing new reaches the public store, and the public meta says paused. */
  get killed(): boolean { return this.localKill || this.remotePaused; }
  get delaySeconds(): number { return Number(this.store.getSetting('delay_seconds') ?? this.cfg.delaySeconds); }

  private syncPublicMeta(): void {
    this.pub.setMeta('paused', this.killed ? '1' : '0');
    this.pub.setMeta('delay_seconds', String(this.delaySeconds));
    this.pub.setMeta('demo', this.cfg.demoMode ? '1' : '0');
    this.pub.setMeta('ship', JSON.stringify(this.manifest()));
  }

  /** Ingest a batch. Invalid events are quarantined (shape only, never their content). */
  ingest(raw: unknown[]): { accepted: number; duplicate: number; quarantined: number } {
    const nowIso = this.now().toISOString();
    let accepted = 0, duplicate = 0, quarantined = 0;
    for (const item of raw) {
      const parsed = CanonicalEvent.safeParse(item);
      if (!parsed.success) {
        quarantined++;
        this.store.quarantine('schema_invalid', null, parsed.error.issues.map((i) => `${i.path.join('.')}:${i.code}`).join(','), nowIso);
        continue;
      }
      const e = parsed.data;
      if (Date.parse(e.occurredAt) > this.now().getTime() + 5 * 60_000) {
        quarantined++;
        this.store.quarantine('future_timestamp', e.eventId, e.type, nowIso);
        continue;
      }
      if (!this.store.append(e, nowIso)) { duplicate++; continue; }
      // capture pre-state needed to project session endings / activity
      const before = e.type === 'session.ended' || e.type === 'session.activity' ? this.world.sessions[e.sessionKey] : undefined;
      const changed = apply(this.world, e);
      this.noteProvenance(e);
      accepted++;
      if (!changed) continue;
      this.classify(e, before, nowIso);
    }
    return { accepted, duplicate, quarantined };
  }

  private noteProvenance(e: CanonicalEvent): void {
    if (e.type === 'session.observed') this.provenance[e.sessionKey] = e.private;
  }

  private classify(e: CanonicalEvent, before: WorldState['sessions'][string] | undefined, nowIso: string): void {
    if (e.type === 'session.activity' && e.kind === 'step') {
      const r = projectStep(e.sessionKey, before?.projectId ?? null, e.step ?? 'other', e.occurredAt, e.fixture, this.policy);
      if (r.ok) this.store.enqueue(draftIdentity(r.draft), r.draft, nowIso, new Date(Date.parse(nowIso) + this.delaySeconds * 1000).toISOString());
      return;
    }
    if (e.type === 'session.activity' && e.kind === 'context') {
      const r = projectContext(e.sessionKey, before?.projectId ?? null, e.context ?? 'unknown', e.compacted === true, e.occurredAt, e.fixture, this.policy);
      if (r.ok) this.store.enqueue(draftIdentity(r.draft), r.draft, nowIso, new Date(Date.parse(nowIso) + this.delaySeconds * 1000).toISOString());
      return;
    }
    if (e.type === 'session.activity') {
      const t = Date.parse(e.occurredAt);
      if (t - (this.lastMishap.get(e.sessionKey) ?? -Infinity) < MISHAP_THROTTLE_MS) return;
      this.lastMishap.set(e.sessionKey, t);
    }
    const r = e.type === 'session.ended'
      ? projectSessionEnded(e.sessionKey, before?.projectId ?? null, before?.harness ?? 'unknown', e.occurredAt, e.fixture, this.policy)
      : e.type === 'session.activity'
        ? projectMishap(e.sessionKey, before?.projectId ?? null, e.occurredAt, e.fixture, e.eventId, this.policy)
        : projectPublic(e, this.policy);
    if (!r.ok) {
      if (r.reason !== 'unattributed' && r.reason !== 'project_not_public') this.store.quarantine(r.reason, e.eventId, e.type, nowIso);
      // A session that is no longer publishable revokes any queued public version of it.
      if (e.type === 'session.observed') this.store.removeOutbox(`worker:w-${this.policy.pseudonym('w', e.sessionKey)}`);
      return;
    }
    const release = new Date(Date.parse(nowIso) + this.delaySeconds * 1000).toISOString();
    this.store.enqueue(draftIdentity(r.draft), r.draft, nowIso, release);
  }

  /** Moves due outbox rows to the public store. Kill switch halts publication entirely. */
  publishDue(): number {
    if (this.killed) return 0;
    const nowIso = this.now().toISOString();
    let n = 0;
    for (const row of this.store.due(nowIso)) {
      // Re-check authorisation at publication time (allowlist may have narrowed since classification).
      const project = 'project' in row.draft ? row.draft.project : null;
      if (project && !this.policy.publicProjects.has(project)) {
        this.store.quarantine('revoked_before_publish', null, row.identity, nowIso);
      } else {
        try {
          this.pub.publish(row.draft, nowIso);
          n++;
        } catch {
          this.store.quarantine('publish_schema_violation', null, row.identity, nowIso);
        }
      }
      this.store.consumeThrough(row.identity, row.id);
    }
    return n;
  }

  /**
   * Startup revocation: if public history contains a project that is no longer allowlisted,
   * purge public history (propagates to replicas via epoch) and record it in the audit log.
   */
  private revokeRemovedProjects(): void {
    const reader = this.pub.db.prepare("SELECT DISTINCT json_extract(body, '$.project') p FROM events WHERE json_extract(body, '$.project') IS NOT NULL").all() as { p: string }[];
    const removed = reader.map((r) => r.p).filter((p) => !this.policy.publicProjects.has(p as ProjectId));
    if (removed.length) {
      this.purgePublic('startup-revocation');
      this.store.audit('system', 'project_revoked', removed.join(','), this.now().toISOString());
    }
  }

  setKill(on: boolean, actor: string): void {
    this.store.setSetting('kill_switch', on ? 'on' : 'off');
    this.store.audit(actor, on ? 'kill_switch_on' : 'kill_switch_off', '', this.now().toISOString());
    this.syncPublicMeta();
  }

  /** Applies the website's pause switch (idempotent; audited only when it changes; survives a restart). */
  setRemotePause(on: boolean, actor = 'cloud'): void {
    if (this.remotePaused === on) return;
    this.store.setSetting('remote_pause', on ? 'on' : 'off');
    this.store.audit(actor, on ? 'cloud_pause_on' : 'cloud_pause_off', '', this.now().toISOString());
    this.syncPublicMeta();
  }

  setDelay(seconds: number, actor: string): void {
    const s = Math.min(120, Math.max(30, Math.round(seconds)));
    this.store.setSetting('delay_seconds', String(s));
    this.store.audit(actor, 'delay_changed', String(s), this.now().toISOString());
    this.syncPublicMeta();
  }

  purgePublic(actor: string): void {
    this.pub.purge();
    const n = this.store.clearOutbox();
    this.store.audit(actor, 'public_purge', `outbox_cleared=${n}`, this.now().toISOString());
  }

  opsState(): unknown {
    const now = this.now().getTime();
    return {
      serverTime: this.now().toISOString(),
      killSwitch: this.killed,
      remotePaused: this.remotePaused,
      delaySeconds: this.delaySeconds,
      demoMode: this.cfg.demoMode,
      publicProjects: this.cfg.publicProjects,
      journalCount: this.store.journalCount(),
      digest: worldDigest(this.world).length,
      provenance: this.provenance,
      sessions: Object.values(this.world.sessions).map((s) => ({ ...s, ageSeconds: Math.round((now - Date.parse(s.lastObservedAt)) / 1000) })),
      pipelines: Object.values(this.world.pipelines).slice(-60),
      deploys: Object.values(this.world.deploys),
      collectors: this.world.collectors,
      outbox: this.store.pending().map((r) => ({ identity: r.identity, kind: r.draft.kind, releaseInSeconds: Math.max(0, Math.round((Date.parse(r.releaseAt) - now) / 1000)), draft: r.draft })),
      quarantineCounts: this.store.quarantineCounts(),
      quarantine: this.store.quarantined(30),
      audit: this.store.audits(30),
      recent: this.store.recentEvents(40).map((e) => ({ eventId: e.eventId, type: e.type, source: e.source, occurredAt: e.occurredAt, private: e.private })),
    };
  }

  /**
   * Liveness sweep (server-derived, labelled as such):
   *  - a collector whose heartbeat stopped is marked disconnected (never left "healthy" forever);
   *  - while the Herdr feed is healthy, sessions not re-observed for STALE_SESSION_MS have
   *    left the workspace snapshot (e.g. ended while the collector restarted) and are ended.
   *  If the feed itself is down we do NOT end sessions: their state is unknown, and the public
   *  feed health already says so.
   */
  sweep(): number {
    const now = this.now();
    const nowIso = now.toISOString();
    const derived: unknown[] = [];
    for (const [name, c] of Object.entries(this.world.collectors)) {
      if (c.health !== 'disconnected' && now.getTime() - Date.parse(c.lastHeartbeatAt) > timeoutFor(name)) {
        derived.push({ schemaVersion: 1, eventId: `sweep-hb-${name}-${nowIso}`, source: 'collector', sourceInstance: 'server-sweep', sourceEventId: `sweep:${name}:${nowIso}`, occurredAt: nowIso, observedAt: nowIso, type: 'collector.heartbeat', collector: name, health: 'disconnected' });
      }
    }
    const herdr = this.world.collectors.herdr;
    if (herdr && herdr.health !== 'disconnected' && now.getTime() - Date.parse(herdr.lastHeartbeatAt) <= timeoutFor('herdr')) {
      for (const sess of Object.values(this.world.sessions)) {
        if (sess.status === 'ended' || sess.fixture) continue;
        if (now.getTime() - Date.parse(sess.lastObservedAt) > STALE_SESSION_MS) {
          derived.push({ schemaVersion: 1, eventId: `sweep-end-${sess.sessionKey}-${nowIso}`.slice(0, 128), source: 'collector', sourceInstance: 'server-sweep', sourceEventId: `sweep:${nowIso}`, occurredAt: nowIso, observedAt: nowIso, type: 'session.ended', sessionKey: sess.sessionKey, reason: 'not_seen_in_snapshot' });
        }
      }
    }
    if (derived.length) this.ingest(derived);
    return derived.length;
  }

  /** `; Secure` whenever the request arrived over HTTPS (TLS socket, or a proxy that says so), or BOTWARREN_OPS_SECURE_COOKIE=1 forces it. */
  private secureCookie(req: import('node:http').IncomingMessage): string {
    const tls = (req.socket as { encrypted?: boolean }).encrypted === true;
    return tls || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase() === 'https' || process.env.BOTWARREN_OPS_SECURE_COOKIE === '1' ? '; Secure' : '';
  }

  start(): void {
    let n = 0;
    this.timer = setInterval(() => { this.publishDue(); if (++n % 15 === 0) this.sweep(); }, 1000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  server(): Server {
    return createServer(async (req, res) => {
      try {
        // this service is loopback only. A page on another origin that rebinds its DNS name to 127.0.0.1 arrives with ITS host name.
        if (!(this.cfg.allowedHosts ?? LOOPBACK_HOSTS).includes(hostName(req.headers.host) ?? '')) return json(res, 421, { error: 'misdirected_request' });
        const url = new URL(req.url ?? '/', 'http://private.local');
        if (req.method === 'POST' && url.pathname === '/ingest') {
          if (!tokenMatches(bearer(req), this.cfg.ingestToken)) return json(res, 401, { error: 'unauthorized' });
          const body = IngestBody.safeParse(JSON.parse(await readBody(req, 1_000_000)));
          if (!body.success) return json(res, 400, { error: 'bad_request' });
          return json(res, 200, this.ingest(body.data.events));
        }
        if (url.pathname === '/healthz') return json(res, 200, { ok: true });

        // --- ops (operator) surface ---
        const sid = cookie(req, 'bw_ops_session');
        const sessionOk = sid !== undefined && (this.opsSessions.get(sid) ?? 0) > Date.now();
        const opsAuthed = tokenMatches(bearer(req), this.cfg.opsToken) || sessionOk;
        if (url.pathname === '/ops/logout' && req.method === 'POST') {
          if (sid) this.opsSessions.delete(sid);
          res.writeHead(303, { location: '/ops', 'set-cookie': `bw_ops_session=; HttpOnly; SameSite=Strict; Path=/ops; Max-Age=0${this.secureCookie(req)}`, ...SECURITY_HEADERS });
          return res.end();
        }
        if (url.pathname === '/ops/login' && req.method === 'POST') {
          if (!this.loginLimiter.allow(clientId(req))) return json(res, 429, { error: 'rate_limited' }, { 'retry-after': '600' });
          const form = new URLSearchParams(await readBody(req, 4096));
          if (!tokenMatches(form.get('token') ?? undefined, this.cfg.opsToken)) return json(res, 401, { error: 'unauthorized' });
          const newSid = randomBytes(32).toString('base64url');
          for (const [k, exp] of this.opsSessions) if (exp < Date.now()) this.opsSessions.delete(k);
          this.opsSessions.set(newSid, Date.now() + 12 * 3600_000);
          this.store.audit('ops', 'login', '', this.now().toISOString());
          res.writeHead(303, { location: '/ops', 'set-cookie': `bw_ops_session=${newSid}; HttpOnly; SameSite=Strict; Path=/ops; Max-Age=43200${this.secureCookie(req)}`, ...SECURITY_HEADERS });
          return res.end();
        }
        if (url.pathname === '/ops' || url.pathname === '/ops/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'", ...SECURITY_HEADERS });
          return res.end(opsAuthed ? (this.cfg.opsHtml?.() ?? '<h1>Botwarren ops</h1>') : LOGIN_HTML);
        }
        if (url.pathname.startsWith('/ops/api/')) {
          if (!opsAuthed) return json(res, 401, { error: 'unauthorized' });
          if (req.method !== 'GET' && req.headers['x-botwarren-ops'] !== '1') return json(res, 403, { error: 'csrf' });
          const route = url.pathname.slice('/ops/api/'.length);
          if (req.method === 'GET' && route === 'state') return json(res, 200, this.opsState());
          if (req.method === 'POST' && route === 'kill') {
            const on = z.object({ on: z.boolean() }).parse(JSON.parse(await readBody(req, 1024))).on;
            this.setKill(on, 'ops');
            return json(res, 200, { killSwitch: this.killed });
          }
          if (req.method === 'POST' && route === 'delay') {
            const s = z.object({ seconds: z.number() }).parse(JSON.parse(await readBody(req, 1024))).seconds;
            this.setDelay(s, 'ops');
            return json(res, 200, { delaySeconds: this.delaySeconds });
          }
          if (req.method === 'GET' && route === 'ship') return json(res, 200, this.manifest());
          if (req.method === 'PUT' && route === 'ship/look') {
            const body = JSON.parse(await readBody(req, 16_000)) as { look: unknown };
            return json(res, 200, { look: this.setLook(body.look ?? null, 'ops') });
          }
          if (req.method === 'POST' && route === 'purge') { this.purgePublic('ops'); return json(res, 200, { purged: true }); }
        }
        return json(res, 404, { error: 'not_found' });
      } catch (err) {
        const status = (err as { status?: number }).status ?? 400;
        return json(res, status, { error: status === 413 ? 'too_large' : 'bad_request' });
      }
    });
  }
}

const LOGIN_HTML = `<!doctype html><meta charset="utf-8"><title>Botwarren Ops — sign in</title>
<style>body{font:15px system-ui;background:#141018;color:#eee;display:grid;place-items:center;height:100vh;margin:0}form{background:#221a28;padding:28px;border-radius:12px;border:1px solid #c0392b55}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #555;background:#0e0b12;color:#eee}button{background:#c0392b;border:0;margin-left:8px}</style>
<form method="post" action="/ops/login"><p><b>PRIVATE</b> · Botwarren operations room</p><input type="password" name="token" placeholder="Ops token" autocomplete="current-password" required><button>Sign in</button></form>`;
