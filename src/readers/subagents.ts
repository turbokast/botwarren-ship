/**
 * Claude Code SUB-AGENT sessions (Task tool), METADATA ONLY. Used by the ship agent.
 *
 * Layout (verified): <projects>/<proj-slug>/<masterSessionId>.jsonl           (the master)
 *                    <projects>/<proj-slug>/<masterSessionId>/subagents/agent-<agentId>.jsonl
 * Every sub-agent becomes its own session: role 'subagent', parentKey = the master's session key,
 * project inherited from the master, model family from the log's top-level `requestedModel` string.
 * Only file names, mtimes and the single `requestedModel` field are read; no prompt or content is kept.
 *
 * State (inferred from mtime): appended within workingMs -> working; otherwise idle; quiet for more than
 * endedMs (2 min: sub-agents are short-lived) -> session.ended. A vanished master ends its sub-agents.
 */
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CanonicalEventInput } from '../vendor/core/contract.ts';
import type { ClaudeLogTail } from './sessionlog.ts';

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'other';

/** Model family from a model string such as "haiku", "claude-sonnet-4-5" or "opus[1m]". */
export function modelFamily(requested: string | null | undefined): ModelFamily | undefined {
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > 200) return undefined;
  const m = requested.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
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

export interface SubagentParent { key: string; file: string; projectId: string | null }

export interface SubagentOptions {
  instance: string;
  source: 'herdr' | 'collector';
  tailFor?: (path: string) => Pick<ClaudeLogTail, 'pollPath' | 'forget'> | undefined;
  workingMs?: number;
  endedMs?: number;
  reobserveMs?: number;
  discoverMs?: number;
  maxPerParent?: number;
  maxTotal?: number;
}

interface Sub {
  key: string; parentKey: string; path: string; status: 'working' | 'idle' | null; projectId: string | null;
  lastEmit: number; model: ModelFamily | undefined; modelTries: number; emittedModel: ModelFamily | undefined;
}

const sha = (...p: string[]) => createHash('sha256').update(p.join('\0')).digest('hex');

export class SubagentWatcher {
  private readonly o: Required<Omit<SubagentOptions, 'tailFor'>> & Pick<SubagentOptions, 'tailFor'>;
  private readonly subs = new Map<string, Sub>();
  private readonly lastDiscover = new Map<string, number>();

  constructor(o: SubagentOptions) {
    this.o = { workingMs: 20_000, endedMs: 120_000, reobserveMs: 120_000, discoverMs: 6_000, maxPerParent: 40, maxTotal: 200, ...o };
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
      this.subs.set(path, { key: `${parent.key}/${basename(e.name, '.jsonl')}`.slice(0, 128), parentKey: parent.key, path, status: null, projectId: null, lastEmit: 0, model: undefined, modelTries: 0, emittedModel: undefined });
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
      if (s.model === undefined && s.modelTries < 5) {
        s.modelTries++;
        s.model = modelFamily(readLogMeta(s.path, ['requestedModel']).requestedModel);
      }
      const changed = s.status !== status || s.projectId !== parent.projectId || s.emittedModel !== s.model;
      if (changed || s.lastEmit === 0 || nowMs - s.lastEmit >= this.o.reobserveMs) {
        s.status = status; s.projectId = parent.projectId; s.lastEmit = nowMs; s.emittedModel = s.model;
        out.push(this.observed(s, now));
      }
      const tail = this.o.tailFor?.(s.path);
      if (tail) {
        try { for (const e of tail.pollPath(s.key, s.path, this.o.instance, now)) out.push({ ...e, source: this.o.source, sourceInstance: this.o.instance } as CanonicalEventInput); } catch { /* skip */ }
      }
    }
    return out;
  }

  private observed(s: Sub, at: Date): CanonicalEventInput {
    const iso = at.toISOString();
    return {
      schemaVersion: 1, eventId: `sub-${sha(s.key, s.status ?? '', iso).slice(0, 32)}`, source: this.o.source, sourceInstance: this.o.instance,
      sourceEventId: `${s.key}@${iso}`.slice(0, 256), occurredAt: iso, observedAt: iso, type: 'session.observed',
      sessionKey: s.key, harness: 'claude', status: s.status ?? 'unknown', projectId: s.projectId,
      // derived through the parent link and file layout: always inferred
      attribution: s.projectId ? { method: 'cwd_registry', certainty: 'inferred' } : { method: 'none', certainty: 'unknown' },
      workCategory: 'unknown', role: 'subagent', parentKey: s.parentKey, ...(s.model ? { model: s.model } : {}),
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
