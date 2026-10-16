/**
 * Codex pairing adapter (METADATA ONLY). Codex CLI writes rollout logs to
 *   <codexDir>/YYYY/MM/DD/rollout-*.jsonl
 * whose first line is {type:'session_meta', payload:{id, cwd, originator, source, cli_version, ...}}.
 * We use ONLY payload.id / cwd / originator / source / reasoning_effort (plus file mtime). The rest of that line
 * (e.g. base_instructions) is never read for any purpose, kept, or emitted.
 *
 * ONE exception among the later lines (owner-approved metadata-only, 2026-10-16): the NEWEST `turn_context` line (bounded tail read) is parsed
 * and only its `payload.model` and `payload.effort` (or `payload.collaboration_mode.settings.model` / `.reasoning_effort`) are taken. The model is
 * classified at once into maker + line by core `classifyModel` and the raw id dropped; the effort goes through `effortLevel`. Every other line
 * (messages, tool calls, instructions) is never read.
 *
 * harness 'codex', model maker/line + effort only when observed in the log (absent until the first turn), certainty inferred. Role 'pair' (parentKey = a Claude master) when an
 * active Claude MAIN session of the same project was written within the last 2 minutes; the choice is the
 * most recently written master and is sticky for the Codex session's life. Otherwise role 'main'.
 * `codex exec` runs (short-lived) end 2 min after their last write; interactive Codex sessions after 30 min.
 */
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { classifyModel, effortLevel, type CanonicalEventInput } from './vendor/core/contract.ts';
import type { ProjectAttributor } from './attribution.ts';
import type { MainInfo } from './sessionscan.ts';
import { sessionEnded, sessionObserved, type Role } from './events.ts';
import { sameIdentity, type LogIdentity } from './readers/sessionlog.ts';

export interface CodexMeta { id?: string; cwd?: string; originator?: string; source?: string; /** normalised reasoning effort of the session_meta line, a fallback until a turn_context exists */ effort?: LogIdentity['effort'] }

const HEAD_WINDOWS = [256 * 1024, 2 * 1024 * 1024];

/**
 * Reads only the first line, keeps only four string fields of `payload`, drops the rest immediately.
 * Returns null when the first line is missing/incomplete/not a session_meta.
 */
export function readCodexMeta(path: string): CodexMeta | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    for (const w of HEAD_WINDOWS) {
      const len = Math.min(size, w);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, 0);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) { if (len === size) return null; continue; } // first line not complete yet / larger than window
      let first: { type?: unknown; payload?: Record<string, unknown> };
      try { first = JSON.parse(buf.subarray(0, nl).toString('utf8')) as typeof first; } catch { return null; }
      if (first.type !== 'session_meta' || typeof first.payload !== 'object' || first.payload === null) return null;
      const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
      const p = first.payload;
      const out: CodexMeta = {};
      const id = str(p.id, 64); if (id && /^[0-9A-Za-z-]{8,64}$/.test(id)) out.id = id;
      const cwd = str(p.cwd, 1024); if (cwd) out.cwd = cwd;
      const originator = str(p.originator, 64); if (originator) out.originator = originator;
      const source = str(p.source, 64); if (source) out.source = source; // may be an object in newer versions: then ignored
      const eff = effortLevel(str(p.reasoning_effort, 32)); if (eff) out.effort = eff;
      return out;
    }
    return null;
  } catch { return null; } finally { closeSync(fd); }
}

const TURN_WINDOWS = [256 * 1024, 2 * 1024 * 1024];

/** Model + effort of ONE parsed `turn_context` line. Only the four named fields are looked at. */
export function identityOfTurnContext(d: { type?: unknown; payload?: unknown }): LogIdentity {
  const out: LogIdentity = {};
  if (d.type !== 'turn_context' || typeof d.payload !== 'object' || d.payload === null) return out;
  const p = d.payload as Record<string, unknown>;
  const s = p.collaboration_mode && typeof p.collaboration_mode === 'object' ? ((p.collaboration_mode as Record<string, unknown>).settings as Record<string, unknown> | undefined) : undefined;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined);
  const id = classifyModel(str(p.model) ?? str(s?.model));
  if (id) { out.maker = id.maker; out.model = id.model; }
  const eff = effortLevel(str(p.effort) ?? str(s?.reasoning_effort));
  if (eff) out.effort = eff;
  return out;
}

/** Newest model + effort in a rollout's tail (bounded; the newest turn_context wins: the model and effort can change between turns). {} when none. */
export function readCodexIdentity(path: string): LogIdentity {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return {}; }
  try {
    const size = fstatSync(fd).size;
    for (const w of TURN_WINDOWS) {
      const len = Math.min(size, w);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (size - len > 0) lines.shift(); // first line is probably cut mid-way
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line.includes('"turn_context"')) continue;
        let d: { type?: unknown; payload?: unknown };
        try { d = JSON.parse(line) as typeof d; } catch { continue; }
        const x = identityOfTurnContext(d);
        if (x.model !== undefined || x.effort !== undefined) return x;
      }
      if (len === size) break;
    }
    return {};
  } catch { return {}; } finally { closeSync(fd); }
}

export interface CodexOptions {
  dirs: string[];
  instance: string;
  attributor: Pick<ProjectAttributor, 'attribute'>;
  workingMs?: number;
  execEndedMs?: number;
  endedMs?: number;
  reobserveMs?: number;
  discoverMs?: number;
  pairWindowMs?: number;
  /** minimum gap between two reads of a rollout's tail for its model/effort */
  identMs?: number;
  /** changes whenever the project list changes: sessions are attributed again at once */
  epoch?: () => number;
  maxSessions?: number;
}

interface CTracked {
  key: string; path: string; mtimeMs: number; meta: CodexMeta | null; metaTries: number; execLike: boolean;
  status: 'working' | 'idle' | null; projectId: string | null; emittedProject?: string | null; role: Role; parentKey: string | undefined; lastEmit: number; attributed: boolean;
  ident: LogIdentity; emittedIdent?: LogIdentity; identAt: number; identMtime: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY/MM/DD day folders that may hold a recent rollout (local + UTC, yesterday..tomorrow). */
export function candidateDays(now: Date): string[] {
  const set = new Set<string>();
  for (const dayOffset of [-1, 0, 1]) {
    const d = new Date(now.getTime() + dayOffset * 86_400_000);
    set.add(`${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`);
    set.add(`${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`);
  }
  return [...set];
}

export class CodexScanner {
  private readonly o: Required<Omit<CodexOptions, 'dirs' | 'instance' | 'attributor'>> & Pick<CodexOptions, 'dirs' | 'instance' | 'attributor'>;
  private readonly tracked = new Map<string, CTracked>();
  /** files seen as too old (path -> mtime) so they are not re-read every discovery */
  private readonly stale = new Map<string, number>();
  private lastDiscover = -Infinity;
  private seenEpoch = 0;

  constructor(opts: CodexOptions) {
    this.o = { workingMs: 20_000, execEndedMs: 120_000, endedMs: 30 * 60_000, reobserveMs: 120_000, discoverMs: 10_000, pairWindowMs: 120_000, identMs: 10_000, maxSessions: 100, epoch: () => 0, ...opts };
  }
  get trackedCount(): number { return this.tracked.size; }

  private discover(now: Date): void {
    const nowMs = now.getTime();
    for (const root of this.o.dirs) {
      for (const day of candidateDays(now)) {
        const dir = join(root, ...day.split('/'));
        let entries: import('node:fs').Dirent[];
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue;
          const path = join(dir, e.name);
          if (this.tracked.has(path) || this.tracked.size >= this.o.maxSessions) continue;
          let m: number;
          try { m = statSync(path).mtimeMs; } catch { continue; }
          if (nowMs - m > this.o.endedMs || this.stale.get(path) === m) continue;
          const key = `codex:${basename(e.name, '.jsonl')}`.slice(0, 128);
          this.tracked.set(path, { key, path, mtimeMs: m, meta: null, metaTries: 0, execLike: false, status: null, projectId: null, role: 'main', parentKey: undefined, lastEmit: 0, attributed: false, ident: {}, identAt: -Infinity, identMtime: -1 });
        }
      }
    }
    if (this.stale.size > 500) this.stale.clear();
  }

  async tick(now: Date, mains: MainInfo[]): Promise<CanonicalEventInput[]> {
    const nowMs = now.getTime();
    if (nowMs - this.lastDiscover >= this.o.discoverMs) { this.discover(now); this.lastDiscover = nowMs; }
    const out: CanonicalEventInput[] = [];
    const ep = this.o.epoch();
    if (ep !== this.seenEpoch) { // the project list changed: attribute the sessions we already know again now
      this.seenEpoch = ep;
      for (const t of this.tracked.values()) if (t.attributed) t.projectId = (await this.o.attributor.attribute(t.meta?.cwd ?? null, nowMs)).projectId;
    }
    await Promise.all([...this.tracked.values()].map(async (t) => {
      let mtime: number;
      try { mtime = statSync(t.path).mtimeMs; } catch { mtime = -Infinity; }
      t.mtimeMs = mtime;
      const age = nowMs - mtime;
      // identity + attribution, once the first line is readable (a few tries: the file may be brand new)
      if (!t.attributed) {
        t.meta = readCodexMeta(t.path);
        if (t.meta === null && ++t.metaTries < 5 && age <= this.o.endedMs) return; // not readable yet
        t.execLike = /exec/i.test(t.meta?.source ?? '') || /exec/i.test(t.meta?.originator ?? '');
        if (t.meta?.id) t.key = `codex:${t.meta.id}`;
        t.projectId = (await this.o.attributor.attribute(t.meta?.cwd ?? null, nowMs)).projectId;
        t.attributed = true;
        if (t.execLike && age > this.o.execEndedMs && age <= this.o.endedMs) { // an old, finished exec run: never observed
          this.tracked.delete(t.path); this.stale.set(t.path, mtime); return;
        }
      }
      const limit = t.execLike ? this.o.execEndedMs : this.o.endedMs;
      if (age > limit) {
        this.tracked.delete(t.path);
        this.stale.set(t.path, mtime);
        if (t.status !== null) out.push(sessionEnded(this.o.instance, t.key, now));
        return;
      }
      const status: 'working' | 'idle' = age <= this.o.workingMs ? 'working' : 'idle';
      // pairing: sticky once chosen
      let roleChanged = false;
      if (t.role !== 'pair' && t.projectId) {
        let best: MainInfo | undefined;
        for (const m of mains) {
          if (m.projectId !== t.projectId || nowMs - m.mtimeMs > this.o.pairWindowMs) continue;
          if (!best || m.mtimeMs > best.mtimeMs) best = m;
        }
        if (best) { t.role = 'pair'; t.parentKey = best.key; roleChanged = true; }
      }
      // model + effort: re-read the newest turn_context only when the rollout grew, at most every `identMs`
      if (t.identMtime !== mtime && nowMs - t.identAt >= this.o.identMs) {
        t.identAt = nowMs; t.identMtime = mtime;
        const found = readCodexIdentity(t.path);
        t.ident = { ...(t.meta?.effort && t.ident.effort === undefined ? { effort: t.meta.effort } : {}), ...t.ident, ...found };
      } else if (t.ident.effort === undefined && t.meta?.effort) t.ident = { ...t.ident, effort: t.meta.effort };
      const identChanged = t.emittedIdent === undefined || !sameIdentity(t.emittedIdent, t.ident);
      if (roleChanged || identChanged || t.status !== status || t.lastEmit === 0 || t.emittedProject !== t.projectId || nowMs - t.lastEmit >= this.o.reobserveMs) {
        t.emittedProject = t.projectId; t.emittedIdent = { ...t.ident };
        t.status = status; t.lastEmit = nowMs;
        out.push(sessionObserved({
          instance: this.o.instance, key: t.key, status, projectId: t.projectId, at: now, harness: 'codex', role: t.role, ...t.ident,
          ...(t.parentKey ? { parentKey: t.parentKey } : {}),
          priv: { cwd: t.meta?.cwd ?? null, log: basename(t.path), originator: t.meta?.originator ?? null, source: t.meta?.source ?? null, attribution: t.projectId ? 'matched' : 'unattributed' },
        }));
      }
    }));
    return out;
  }
}
