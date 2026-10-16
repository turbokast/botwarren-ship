/**
 * Claude Code SUB-AGENT sessions (Task tool), METADATA ONLY. Used by the ship agent.
 *
 * Layout (verified): <projects>/<proj-slug>/<masterSessionId>.jsonl           (the master)
 *                    <projects>/<proj-slug>/<masterSessionId>/subagents/agent-<agentId>.jsonl
 * Every sub-agent becomes its own session: role 'subagent', parentKey = the master's session key,
 * project inherited from the master, model maker + line and reasoning effort from the log's top-level `requestedModel` / `effort` and `message.model`
 * (classified by core `classifyModel`; the raw id never leaves this module). Only file names, mtimes and those fields are read; no prompt or content is kept.
 *
 * State (inferred from mtime): appended within workingMs -> working; otherwise idle; quiet for more than
 * endedMs (2 min: sub-agents are short-lived) -> session.ended. A vanished master ends its sub-agents.
 */
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { classifyModel, type CanonicalEventInput } from '../vendor/core/contract.ts';
import { identityOfLine, readTailIdentity, sameIdentity, type AreaProbe, type ClaudeLogTail, type LogIdentity } from './sessionlog.ts';

/**
 * Context-window family of a model string such as "haiku", "claude-sonnet-4-5" or "opus[1m]": ONLY for sizing the context gauge
 * (contextfill.ts), where just the three Claude lines with a known window count. Public model identity is `classifyModel`.
 */
export function modelFamily(requested: string | null | undefined): 'opus' | 'sonnet' | 'haiku' | 'other' | undefined {
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > 200) return undefined;
  const m = classifyModel(requested)?.model;
  return m === 'opus' || m === 'sonnet' || m === 'haiku' ? m : 'other';
}

const WINDOWS = [64 * 1024, 1024 * 1024];

/**
 * Newest values of the given TOP-LEVEL string keys, scanning complete JSONL lines from the tail, then
 * (for keys still missing) from the head. Bounded reads; only the requested keys are ever returned.
 */
export function readLogMeta(path: string, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return out; }
  try {
    const size = fstatSync(fd).size;
    const collect = (lines: string[]) => {
      for (const line of lines) {
        if (keys.every((k) => k in out)) return;
        if (!keys.some((k) => !(k in out) && line.includes(`"${k}"`))) continue;
        let d: Record<string, unknown>;
        try { d = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        for (const k of keys) { const v = d[k]; if (!(k in out) && typeof v === 'string' && v.length > 0 && v.length <= 1024) out[k] = v; }
      }
    };
    for (const w of WINDOWS) {
      const len = Math.min(size, w);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (size - len > 0) lines.shift();
      collect(lines.reverse());
      if (keys.every((k) => k in out) || len === size) break;
    }
    if (!keys.every((k) => k in out)) {
      for (const w of WINDOWS) {
        const len = Math.min(size, w);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, 0);
        const lines = buf.toString('utf8').split('\n');
        if (len < size) lines.pop(); // last line is probably cut
        collect(lines);
        if (keys.every((k) => k in out) || len === size) break;
      }
    }
  } catch { /* unreadable: return what we have */ } finally { closeSync(fd); }
  return out;
}

/** Directory holding a master's sub-agent logs. */
export const subagentsDir = (masterFile: string): string => join(dirname(masterFile), basename(masterFile, '.jsonl'), 'subagents');

export interface SubagentParent { key: string; file: string; projectId: string | null; /** the master's working folder (local only; used by Code map to resolve a relative path) */ cwd?: string | null }

/** Code map hook (opt-in, default off): `on()` is asked on every poll, `areaOf` is the only code that sees a path. */
export interface CodeMapHook { on(): boolean; areaOf(projectId: string | null, cwd: string | null, rawPath: string, edit: boolean): number | null }

export interface SubagentOptions {
  instance: string;
  source: 'herdr' | 'collector';
  tailFor?: (path: string) => Pick<ClaudeLogTail, 'pollPath' | 'forget'> | undefined;
  codemap?: CodeMapHook;
  workingMs?: number;
  endedMs?: number;
  reobserveMs?: number;
  discoverMs?: number;
  /** minimum gap between two reads of a sub-agent log for its model/effort */
  identMs?: number;
  maxPerParent?: number;
  maxTotal?: number;
}

interface Sub {
  key: string; parentKey: string; path: string; status: 'working' | 'idle' | null; projectId: string | null;
  lastEmit: number; ident: LogIdentity; identTries: number; identAt: number; emittedIdent: LogIdentity | undefined;
}

const sha = (...p: string[]) => createHash('sha256').update(p.join('\0')).digest('hex');

export class SubagentWatcher {
  private readonly o: Required<Omit<SubagentOptions, 'tailFor' | 'codemap'>> & Pick<SubagentOptions, 'tailFor' | 'codemap'>;
  private readonly subs = new Map<string, Sub>();
  private readonly lastDiscover = new Map<string, number>();

  constructor(o: SubagentOptions) {
    this.o = { workingMs: 20_000, endedMs: 120_000, reobserveMs: 120_000, discoverMs: 6_000, identMs: 8_000, maxPerParent: 40, maxTotal: 200, ...o };
  }
  get trackedCount(): number { return this.subs.size; }

  private discover(parent: SubagentParent, nowMs: number): void {
    const dir = subagentsDir(parent.file);
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    let n = [...this.subs.values()].filter((s) => s.parentKey === parent.key).length;
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith('agent-') || !e.name.endsWith('.jsonl')) continue; // symlinks are never followed
      const path = join(dir, e.name);
      if (this.subs.has(path) || n >= this.o.maxPerParent || this.subs.size >= this.o.maxTotal) continue;
      let m: number;
      try { m = statSync(path).mtimeMs; } catch { continue; }
      if (nowMs - m > this.o.endedMs) continue; // only recent sub-agents are of interest
      this.subs.set(path, { key: `${parent.key}/${basename(e.name, '.jsonl')}`.slice(0, 128), parentKey: parent.key, path, status: null, projectId: null, lastEmit: 0, ident: {}, identTries: 0, identAt: -Infinity, emittedIdent: undefined });
      n++;
    }
  }

  tick(parents: SubagentParent[], now: Date): CanonicalEventInput[] {
    const nowMs = now.getTime();
    const out: CanonicalEventInput[] = [];
    const byKey = new Map(parents.map((p) => [p.key, p]));
    for (const p of parents) {
      if (nowMs - (this.lastDiscover.get(p.key) ?? -Infinity) >= this.o.discoverMs) { this.discover(p, nowMs); this.lastDiscover.set(p.key, nowMs); }
    }
    for (const k of this.lastDiscover.keys()) if (!byKey.has(k)) this.lastDiscover.delete(k);

    for (const s of [...this.subs.values()]) {
      const parent = byKey.get(s.parentKey);
      let age = Infinity;
      if (parent) { try { age = nowMs - statSync(s.path).mtimeMs; } catch { age = Infinity; } }
      if (!parent || age > this.o.endedMs) {
        this.subs.delete(s.path);
        this.o.tailFor?.(s.path)?.forget(s.key);
        if (s.status !== null) out.push(this.ended(s, now));
        continue;
      }
      const status: 'working' | 'idle' = age <= this.o.workingMs ? 'working' : 'idle';
      // model + effort: the newest assistant line of the sub-agent's own log (it can change per turn, so re-read while the file is being written,
      // at most every `identMs`, every second while no model is known yet); a brand-new log may have no assistant line yet, so the top-level `requestedModel` of the first lines is tried too.
      if (nowMs - s.identAt >= (s.ident.model === undefined ? 1_000 : this.o.identMs) && (age <= this.o.workingMs || s.ident.model === undefined) && s.identTries < 100) {
        s.identAt = nowMs; s.identTries++;
        const found = readTailIdentity(s.path);
        if (found.model === undefined && s.ident.model === undefined) {
          const rm = readLogMeta(s.path, ['requestedModel', 'effort']);
          const head = identityOfLine({ requestedModel: rm.requestedModel, effort: rm.effort });
          s.ident = { ...head, ...s.ident };
        } else s.ident = { ...s.ident, ...found };
      }
      const changed = s.status !== status || s.projectId !== parent.projectId || s.emittedIdent === undefined || !sameIdentity(s.emittedIdent, s.ident);
      if (changed || s.lastEmit === 0 || nowMs - s.lastEmit >= this.o.reobserveMs) {
        s.status = status; s.projectId = parent.projectId; s.lastEmit = nowMs; s.emittedIdent = { ...s.ident };
        out.push(this.observed(s, now));
      }
      const tail = this.o.tailFor?.(s.path);
      if (tail) {
        try { for (const e of tail.pollPath(s.key, s.path, this.o.instance, now, this.probe(parent.projectId, parent.cwd ?? null))) out.push({ ...e, source: this.o.source, sourceInstance: this.o.instance } as CanonicalEventInput); } catch { /* skip */ }
      }
    }
    return out;
  }

  private probe(projectId: string | null, cwd: string | null): AreaProbe | undefined {
    const cm = this.o.codemap;
    return cm && projectId !== null && cm.on() ? (raw, edit) => cm.areaOf(projectId, cwd, raw, edit) : undefined;
  }

  private observed(s: Sub, at: Date): CanonicalEventInput {
    const iso = at.toISOString();
    return {
      schemaVersion: 1, eventId: `sub-${sha(s.key, s.status ?? '', iso).slice(0, 32)}`, source: this.o.source, sourceInstance: this.o.instance,
      sourceEventId: `${s.key}@${iso}`.slice(0, 256), occurredAt: iso, observedAt: iso, type: 'session.observed',
      sessionKey: s.key, harness: 'claude', status: s.status ?? 'unknown', projectId: s.projectId,
      // derived through the parent link and file layout: always inferred
      attribution: s.projectId ? { method: 'cwd_registry', certainty: 'inferred' } : { method: 'none', certainty: 'unknown' },
      workCategory: 'unknown', role: 'subagent', parentKey: s.parentKey,
      ...(s.ident.maker ? { maker: s.ident.maker } : {}), ...(s.ident.model ? { model: s.ident.model } : {}), ...(s.ident.effort ? { effort: s.ident.effort } : {}),
      private: { log: basename(s.path), parent: s.parentKey },
    };
  }

  private ended(s: Sub, at: Date): CanonicalEventInput {
    const iso = at.toISOString();
    return {
      schemaVersion: 1, eventId: `sub-${sha(s.key, 'ended', iso).slice(0, 32)}`, source: this.o.source, sourceInstance: this.o.instance,
      sourceEventId: `${s.key}@end@${iso}`.slice(0, 256), occurredAt: iso, observedAt: iso, type: 'session.ended', sessionKey: s.key, reason: 'unknown',
    };
  }
}
