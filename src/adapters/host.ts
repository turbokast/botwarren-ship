/**
 * Adapter host (the "core" of the adapter architecture).
 *
 *  1. polls each enabled adapter (errors isolated, logged as a code only),
 *  2. validates every Observation against the strict schema (invalid ones are dropped and counted),
 *  3. normalises keys (`safeKey`), checks project ids against the configured set,
 *  4. MERGES observations that describe the same real session (shared correlation ids, e.g. a Claude session that is
 *     also a Herdr pane and a Ninox session) into ONE session, field by field from the most authoritative source,
 *  5. builds canonical events. Adapters never construct canonical events and never see the wire format.
 */
import { createHash } from 'node:crypto';
import type { CanonicalEventInput } from '../vendor/core/contract.ts';
import {
  ObservationSchema, PolicyError, safeErrorCode, safeKey,
  type Adapter, type AdapterContext, type AdapterId, type AdapterSettings, type LogCode, type ProjectRef, type SessionObs,
} from './api.ts';
import { makeLoopbackHttp, makeScopedFs } from './policy.ts';
import type { Host } from '../paths.ts';

const sha = (...p: string[]) => createHash('sha256').update(p.join('\0')).digest('hex');

/** Who wins a field when several adapters report the same session. Earlier = more authoritative. */
const STATUS_ORDER: AdapterId[] = ['ninox', 'herdr', 'opencode', 'claude-code', 'codex', 'gemini-cli'];
const ROLE_ORDER: AdapterId[] = ['ninox', 'codex', 'claude-code', 'herdr', 'opencode', 'gemini-cli'];
const FIELD_ORDER: AdapterId[] = ['claude-code', 'codex', 'opencode', 'gemini-cli', 'herdr', 'ninox'];

interface Src { adapter: AdapterId; obs: SessionObs }
interface Rec { key: string; sources: Map<string, Src>; sig: string; lastEmit: number; born: number }

export interface HostOptions {
  adapters: { adapter: Adapter; settings: AdapterSettings }[];
  /** detection for `enabled: "auto"` adapters (cached 60 s). Without it, auto adapters are polled unconditionally. */
  detect?: (adapter: Adapter, settings: AdapterSettings) => Promise<{ found: boolean }>;
  instance: string;
  host: Host;
  projects: ProjectRef[];
  attribute: (cwd: string | null | undefined, nowMs: number) => Promise<string | null>;
  attributionEpoch?: () => number;
  log: (msg: string) => void;
  reobserveMs?: number;
  maxSessions?: number;
  maxObsPerPoll?: number;
}

export interface AdapterStatus { id: AdapterId; state: 'ok' | 'degraded' | 'unsupported_version' | 'failed' | 'idle'; code: string; rejected: number; sessions: number }

export class AdapterHost {
  private readonly o: Required<Pick<HostOptions, 'reobserveMs' | 'maxSessions' | 'maxObsPerPoll'>> & HostOptions;
  private readonly corr = new Map<string, string>();
  private readonly recs = new Map<string, Rec>();
  private readonly srcIndex = new Map<string, string>();
  private readonly ctxs = new Map<AdapterId, AdapterContext>();
  private readonly status = new Map<AdapterId, AdapterStatus>();
  private readonly pollRequested = new Set<AdapterId>();
  private started = false;
  private readonly detected = new Map<AdapterId, { found: boolean; at: number }>();
  onWake: (() => void) | undefined;

  constructor(opts: HostOptions) {
    this.o = { reobserveMs: 120_000, maxSessions: 300, maxObsPerPoll: 2000, ...opts };
    for (const { adapter } of opts.adapters) this.status.set(adapter.manifest.id, { id: adapter.manifest.id, state: 'idle', code: 'none', rejected: 0, sessions: 0 });
  }

  get sessionCount(): number { return this.recs.size; }
  statuses(): AdapterStatus[] {
    const out = [...this.status.values()].map((s) => ({ ...s, sessions: [...this.recs.values()].filter((r) => [...r.sources.values()].some((x) => x.adapter === s.id)).length }));
    return out;
  }

  private ctxFor(adapter: Adapter, settings: AdapterSettings): AdapterContext {
    const id = adapter.manifest.id;
    const hit = this.ctxs.get(id);
    if (hit) return hit;
    const roots = adapter.manifest.reads.filter((r) => r.kind === 'dir' || r.kind === 'file').map((r) => r.target);
    const loop = adapter.manifest.reads.find((r) => r.kind === 'loopback-http');
    const allow = loop ? adapter.manifest.reads.filter((r) => r.kind === 'loopback-http' && r.target.startsWith('GET ')).map((r) => r.target.slice(4)) : [];
    const port = settings.port ?? 0;
    const ctx: AdapterContext = {
      host: this.o.host, instance: this.o.instance, settings, projects: this.o.projects,
      attribute: this.o.attribute, attributionEpoch: this.o.attributionEpoch ?? (() => 0),
      http: port > 0 && allow.length > 0
        ? makeLoopbackHttp({ allow, port, ...(settings.host ? { host: settings.host } : {}), auth: adapter.httpAuth?.(this.o.host.env) ?? undefined })
        : { get: () => Promise.reject(new PolicyError('no loopback access declared')), sse: () => Promise.reject(new PolicyError('no loopback access declared')) },
      fs: makeScopedFs(roots),
      log: (code: LogCode, n?: number) => this.o.log(`adapter ${id}: ${code}${typeof n === 'number' && Number.isFinite(n) ? ` (${Math.trunc(n)})` : ''}`),
      requestPoll: () => { this.pollRequested.add(id); this.onWake?.(); },
    };
    this.ctxs.set(id, ctx);
    return ctx;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const { adapter, settings } of this.o.adapters) {
      try { await adapter.start?.(this.ctxFor(adapter, settings)); } catch (e) { this.o.log(`adapter ${adapter.manifest.id}: start failed (${safeErrorCode(e)})`); }
    }
  }

  async stop(): Promise<void> {
    for (const { adapter } of this.o.adapters) { try { await adapter.stop?.(); } catch { /* ignore */ } }
  }

  private readonly detecting = new Set<AdapterId>();
  private refreshDetect(adapter: Adapter, settings: AdapterSettings, nowMs: number): void {
    const id = adapter.manifest.id;
    if (this.detecting.has(id) || !this.o.detect) return;
    this.detecting.add(id);
    void this.o.detect(adapter, settings).then((d) => d.found, () => false).then((found) => { this.detected.set(id, { found, at: nowMs }); this.detecting.delete(id); });
  }

  /** Adapters that asked for an early poll since the last call. */
  takePollRequests(): AdapterId[] { const r = [...this.pollRequested]; this.pollRequested.clear(); return r; }

  /** One poll round over all adapters (or only `only`). Returns canonical events. */
  async tick(now: Date, only?: ReadonlySet<AdapterId>): Promise<CanonicalEventInput[]> {
    const nowMs = now.getTime();
    const touched = new Set<string>();
    const out: CanonicalEventInput[] = [];
    const activities: { adapter: AdapterId; obs: Extract<ReturnType<typeof ObservationSchema.parse>, { kind: 'activity' }> }[] = [];

    // Adapters poll concurrently (a slow tool must not delay the others); Codex waits for Claude (pairing needs fresh masters).
    const polls = new Map<AdapterId, Promise<unknown[] | null>>();
    const pollOne = async (adapter: Adapter, settings: AdapterSettings): Promise<unknown[] | null> => {
      const id = adapter.manifest.id;
      const st = this.status.get(id)!;
      if (settings.enabled === false) return null;
      if (settings.enabled === 'auto' && this.o.detect) {
        const d = this.detected.get(id);
        if (!d || nowMs - d.at >= 60_000) this.refreshDetect(adapter, settings, nowMs); // in the background: never blocks a tick
        if (!d || !d.found) { st.state = 'idle'; st.code = 'not_detected'; return null; }
      }
      if (id === 'codex') await polls.get('claude-code')?.catch(() => null);
      try {
        const raw = await Promise.race([adapter.poll(this.ctxFor(adapter, settings), now), new Promise<never>((_r, rej) => { const t = setTimeout(() => rej(Object.assign(new Error('t'), { code: 'POLL_TIMEOUT' })), 15_000); t.unref(); })]);
        if (st.state === 'failed') this.o.log(`adapter ${id}: recovered`);
        st.state = 'ok'; st.code = 'none'; // a successful poll; a health observation below may downgrade it
        return raw;
      } catch (e) {
        const code = safeErrorCode(e);
        if (st.state !== 'failed' || st.code !== code) this.o.log(`adapter ${id}: poll failed (${code})`);
        st.state = 'failed'; st.code = code;
        return null;
      }
    };
    for (const { adapter, settings } of this.o.adapters) {
      if (only && !only.has(adapter.manifest.id)) continue;
      polls.set(adapter.manifest.id, pollOne(adapter, settings));
    }
    await Promise.all(polls.values());

    for (const { adapter } of this.o.adapters) {
      const id = adapter.manifest.id;
      const st = this.status.get(id)!;
      let raw = await polls.get(id);
      if (!raw) continue;
      if (raw.length > this.o.maxObsPerPoll) { raw = raw.slice(0, this.o.maxObsPerPoll); this.o.log(`adapter ${id}: too_many_sessions (${this.o.maxObsPerPoll})`); }
      for (const r of raw) {
        const p = ObservationSchema.safeParse(r);
        if (!p.success) { st.rejected++; continue; }
        const obs = p.data;
        switch (obs.kind) {
          case 'adapter.health': st.state = obs.state; st.code = obs.code; break;
          case 'session': {
            if (obs.projectId !== null && !this.o.projects.some((x) => x.id === obs.projectId)) { st.rejected++; break; }
            this.registerSession(id, obs, touched);
            break;
          }
          case 'session.ended': this.endSource(id, safeKey(obs.key), obs.reason, now, touched, out); break;
          case 'activity': activities.push({ adapter: id, obs }); break;
        }
      }
    }

    // merged session events (after ALL registrations, so parents resolve across adapters)
    for (const ck of touched) {
      const rec = this.recs.get(ck);
      if (rec) { const ev = this.emitMerged(rec, now, nowMs); if (ev) out.push(ev); }
    }
    for (const { obs } of activities) {
      const ck = this.corr.get(`key:${safeKey(obs.key)}`) ?? safeKey(obs.key);
      if (!this.recs.has(ck)) continue; // activity of a session no adapter reports as live: dropped
      const at = obs.at;
      out.push({
        schemaVersion: 1, eventId: `act-${sha(ck, obs.act, obs.toolCategory, obs.step ?? '', obs.context ?? '', String(obs.compacted ?? ''), String(obs.area ?? ''), at).slice(0, 32)}`,
        source: 'collector', sourceInstance: this.o.instance, sourceEventId: `${obs.act}:${at}`.slice(0, 256), occurredAt: at, observedAt: now.toISOString(),
        type: 'session.activity', sessionKey: ck, kind: obs.act, toolCategory: obs.toolCategory,
        ...(obs.step ? { step: obs.step } : {}), ...(obs.context ? { context: obs.context } : {}), ...(obs.compacted ? { compacted: true } : {}),
        ...(obs.act === 'area' && obs.area ? { area: obs.area, areaAct: obs.areaAct ?? 'read' } : {}),
      } as CanonicalEventInput);
    }
    out.push(...this.drainMergedEnds(now));
    return out;
  }

  // ------------------------------------------------------------------ merge

  private corrIds(adapterId: AdapterId, obs: SessionObs, key: string): string[] {
    void adapterId;
    const ids = [`key:${key}`];
    for (const c of obs.correlate) ids.push(`${c.type}:${safeKey(c.id)}`);
    return ids;
  }

  /** The key a session gets when a Claude/Codex session id is known: stable regardless of which adapter sees it first. */
  private preferredKey(obs: SessionObs, key: string): string {
    for (const c of obs.correlate) {
      if (c.type === 'claude-session') return `claude:${safeKey(c.id)}`;
      if (c.type === 'codex-session') return `codex:${safeKey(c.id)}`;
    }
    return key;
  }

  private registerSession(adapterId: AdapterId, obs: SessionObs, touched: Set<string>): void {
    const key = safeKey(obs.key);
    const srcId = `${adapterId}|${key}`;
    const ids = this.corrIds(adapterId, obs, key);
    const cks = new Set<string>();
    const existing = this.srcIndex.get(srcId);
    if (existing && this.recs.has(existing)) cks.add(existing);
    for (const c of ids) { const ck = this.corr.get(c); if (ck && this.recs.has(ck)) cks.add(ck); }
    const preferred = this.preferredKey(obs, key);
    let ck: string;
    if (cks.size === 0) {
      if (this.recs.size >= this.o.maxSessions) return;
      ck = preferred;
      this.recs.set(ck, { key: ck, sources: new Map(), sig: '', lastEmit: 0, born: 0 });
    } else if (cks.size === 1) {
      ck = [...cks][0]!;
    } else {
      // two records turned out to be the same session: keep the preferred key (else the oldest), fold the others in
      const list = [...cks];
      ck = list.includes(preferred) ? preferred : list[0]!;
      for (const loser of list) {
        if (loser === ck) continue;
        const lr = this.recs.get(loser)!;
        const wr = this.recs.get(ck)!;
        for (const [sid, s] of lr.sources) { wr.sources.set(sid, s); this.srcIndex.set(sid, ck); }
        for (const [c, v] of this.corr) if (v === loser) this.corr.set(c, ck);
        this.recs.delete(loser);
        touched.delete(loser);
        this.pendingEnds.push({ key: loser, hadEmitted: lr.lastEmit > 0 });
      }
    }
    const rec = this.recs.get(ck)!;
    rec.sources.set(srcId, { adapter: adapterId, obs: { ...obs, key } });
    this.srcIndex.set(srcId, ck);
    for (const c of ids) this.corr.set(c, ck);
    touched.add(ck);
  }

  /** Sessions folded into another one: ended once, so the crew member is not drawn twice. */
  private readonly pendingEnds: { key: string; hadEmitted: boolean }[] = [];

  private endSource(adapterId: AdapterId, key: string, reason: string, now: Date, touched: Set<string>, out: CanonicalEventInput[]): void {
    const srcId = `${adapterId}|${key}`;
    const ck = this.srcIndex.get(srcId);
    if (!ck) return;
    this.srcIndex.delete(srcId);
    const rec = this.recs.get(ck);
    if (!rec) return;
    rec.sources.delete(srcId);
    if (rec.sources.size > 0) { touched.add(ck); return; }
    touched.delete(ck);
    this.recs.delete(ck);
    for (const [c, v] of this.corr) if (v === ck) this.corr.delete(c);
    if (rec.lastEmit > 0) out.push(this.endedEvent(ck, reason, now));
  }

  private endedEvent(key: string, reason: string, now: Date): CanonicalEventInput {
    const iso = now.toISOString();
    return {
      schemaVersion: 1, eventId: `ship-${sha(key, 'ended', iso).slice(0, 32)}`, source: 'collector', sourceInstance: this.o.instance,
      sourceEventId: `${key}@end@${iso}`.slice(0, 256), occurredAt: iso, observedAt: iso, type: 'session.ended', sessionKey: key,
      reason: (['pane_closed', 'agent_exited', 'not_seen_in_snapshot', 'unknown'].includes(reason) ? reason : 'unknown') as 'unknown',
    };
  }

  private firstBy<T>(rec: Rec, order: AdapterId[], pick: (s: Src) => T | undefined): T | undefined {
    const srcs = [...rec.sources.values()].sort((a, b) => order.indexOf(a.adapter) - order.indexOf(b.adapter));
    for (const s of srcs) { const v = pick(s); if (v !== undefined) return v; }
    return undefined;
  }

  private emitMerged(rec: Rec, now: Date, nowMs: number): CanonicalEventInput | null {
    const srcs = [...rec.sources.values()];
    if (srcs.length === 0) return null;
    const status = srcs.some((s) => s.obs.status === 'blocked') ? 'blocked'
      : (this.firstBy(rec, STATUS_ORDER, (s) => (s.obs.status !== 'unknown' ? s.obs.status : undefined)) ?? 'unknown');
    const harness = this.firstBy(rec, FIELD_ORDER, (s) => (s.obs.harness !== 'unknown' ? s.obs.harness : undefined)) ?? 'unknown';
    const roleSrc = [...srcs].sort((a, b) => ROLE_ORDER.indexOf(a.adapter) - ROLE_ORDER.indexOf(b.adapter)).find((s) => s.obs.role !== 'main' && s.obs.parentKey);
    const role = roleSrc ? roleSrc.obs.role : 'main';
    let parentKey: string | undefined;
    if (roleSrc?.obs.parentKey) {
      const raw = safeKey(roleSrc.obs.parentKey);
      parentKey = this.corr.get(`key:${raw}`) ?? raw;
      if (parentKey === rec.key) parentKey = undefined;
    }
    // model identity: maker and line always come from the SAME source (the most authoritative one that observed a model: the session logs first),
    // so a livery never pairs with another tool's body type. Effort is picked on its own: any source that observed it, same order.
    const idSrc = this.firstBy(rec, FIELD_ORDER, (s) => (s.obs.model !== undefined || s.obs.maker !== undefined ? s : undefined));
    const maker = idSrc?.obs.maker; const model = idSrc?.obs.model;
    const effort = this.firstBy(rec, FIELD_ORDER, (s) => s.obs.effort);
    const projectId = this.firstBy(rec, FIELD_ORDER, (s) => s.obs.projectId ?? undefined) ?? null;
    const certainty = srcs.some((s) => s.obs.certainty === 'observed') ? 'observed' : 'inferred';
    const workCategory = this.firstBy(rec, FIELD_ORDER, (s) => (s.obs.workCategory && s.obs.workCategory !== 'unknown' ? s.obs.workCategory : undefined)) ?? 'unknown';
    const tool = this.firstBy(rec, FIELD_ORDER, (s) => (s.obs.tool !== 'other' ? s.obs.tool : undefined)) ?? 'other';
    const local = srcs.reduce<Record<string, string | number | boolean | null>>((acc, s) => {
      for (const [k, v] of Object.entries(s.obs.local ?? {})) if (!(k in acc) && v !== undefined) acc[k] = v as string | number;
      return acc;
    }, {});
    const sig = JSON.stringify([status, harness, role, parentKey ?? '', maker ?? '', model ?? '', effort ?? '', projectId, certainty, workCategory, tool, srcs.map((s) => s.adapter).sort()]);
    if (sig === rec.sig && nowMs - rec.lastEmit < this.o.reobserveMs) return null;
    if (rec.born === 0) rec.born = nowMs;
    rec.sig = sig; rec.lastEmit = nowMs;
    const at = now.toISOString();
    return {
      schemaVersion: 1, eventId: `ship-${sha(rec.key, status, role, parentKey ?? '', at).slice(0, 32)}`, source: 'collector', sourceInstance: this.o.instance,
      sourceEventId: `${rec.key}@${at}`.slice(0, 256), occurredAt: at, observedAt: at, type: 'session.observed',
      sessionKey: rec.key, harness, status, projectId,
      attribution: projectId ? { method: 'cwd_registry', certainty } : { method: 'none', certainty: 'unknown' },
      workCategory, role, ...(parentKey ? { parentKey } : {}), ...(maker ? { maker } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      private: { ...local, tool, adapters: [...new Set(srcs.map((s) => s.adapter))].sort().join('+'), attribution: projectId ? 'matched' : 'unattributed' },
    } as CanonicalEventInput;
  }

  /** Sessions folded into another one in this round (call after tick; the events are returned by `drainMergedEnds`). */
  drainMergedEnds(now: Date): CanonicalEventInput[] {
    const ends = this.pendingEnds.splice(0).filter((e) => e.hadEmitted).map((e) => this.endedEvent(e.key, 'unknown', now));
    return ends;
  }
}
