/**
 * Log-based session adapter (Claude Code, cross-platform, METADATA ONLY).
 *
 * Reads: file names, mtimes, sizes (stat) and, to attribute a project, the top-level `cwd` of the
 * newest few lines of each active log. Task-tool sub-agent logs (<id>/subagents/agent-*.jsonl) are handled
 * by the shared SubagentWatcher (role 'subagent', parentKey = this master's key, model from requestedModel). Message/prompt/tool text is never kept or emitted.
 * ClaudeLogTail (owner-approved metadata-only reader) supplies tool_error + step events.
 *
 * State (inferred, never observed):
 *   appended within `workingMs` (20 s)          -> working
 *   quiet for 20 s .. `endedMs` (30 min)        -> idle
 *   quiet longer than 30 min                    -> session.ended, then forgotten until written again
 */
import { closeSync, openSync, readdirSync, readSync, statSync, fstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { CanonicalEventInput } from './vendor/core/contract.ts';
import { ClaudeLogTail } from './readers/sessionlog.ts';
import { SubagentWatcher, type SubagentParent } from './readers/subagents.ts';
import type { ProjectAttributor } from './attribution.ts';
import { sessionEnded, sessionObserved } from './events.ts';

export interface ScannerOptions {
  dirs: string[];
  instance: string;
  attributor: Pick<ProjectAttributor, 'attribute'>;
  workingMs?: number;
  endedMs?: number;
  reobserveMs?: number;
  discoverMs?: number;
  cwdTtlMs?: number;
  /** changes whenever the project list changes: sessions are attributed again at once */
  epoch?: () => number;
  maxSessions?: number;
}

interface Tracked {
  key: string; path: string; status: 'working' | 'idle' | null; projectId: string | null;
  lastEmit: number; emittedProject?: string | null; cwd: string | null; cwdAt: number; resolved: boolean; mtimeMs: number;
}

/** What the Codex pairing logic needs to know about a live Claude MAIN session. */
export interface MainInfo { key: string; projectId: string | null; mtimeMs: number }

const TAIL_BYTES = [64 * 1024, 1024 * 1024];

/** Newest top-level `cwd` string found in the tail of a JSONL file, or null. Bounded reads. */
export function readNewestCwd(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    for (const window of TAIL_BYTES) {
      const len = Math.min(size, window);
      const start = size - len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // first line is probably cut mid-way
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line.includes('"cwd"')) continue;
        try {
          const d = JSON.parse(line) as { cwd?: unknown };
          if (typeof d.cwd === 'string' && d.cwd.length > 0 && d.cwd.length <= 1024) return d.cwd;
        } catch { /* partial / non-JSON line */ }
      }
      if (len === size) break;
    }
    return null;
  } catch { return null; } finally { closeSync(fd); }
}

export class SessionScanner {
  private readonly o: Required<Omit<ScannerOptions, 'attributor' | 'dirs' | 'instance'>> & Pick<ScannerOptions, 'attributor' | 'dirs' | 'instance'>;
  private readonly tracked = new Map<string, Tracked>();
  private readonly tails = new Map<string, ClaudeLogTail>();
  private lastDiscover = -Infinity;
  private seenEpoch = 0;
  private readonly subagents: SubagentWatcher;

  constructor(opts: ScannerOptions) {
    this.o = {
      workingMs: 20_000, endedMs: 30 * 60_000, reobserveMs: 120_000, discoverMs: 15_000, cwdTtlMs: 60_000, maxSessions: 200, epoch: () => 0, ...opts,
    };
    for (const d of opts.dirs) this.tails.set(d, new ClaudeLogTail(d));
    this.subagents = new SubagentWatcher({ instance: opts.instance, source: 'collector', tailFor: (path) => this.tailFor(path) });
  }

  get subagentCount(): number { return this.subagents.trackedCount; }

  /** Live Claude main sessions (with last write time), for Codex pairing. */
  mains(): MainInfo[] {
    return [...this.tracked.values()].filter((t) => t.status !== null).map((t) => ({ key: t.key, projectId: t.projectId, mtimeMs: t.mtimeMs }));
  }

  get trackedCount(): number { return this.tracked.size; }

  /** Finds recently written session logs: <dir>/<proj>/<id>.jsonl and <dir>/<proj>/<id>/subagents/*.jsonl. */
  private discover(nowMs: number): void {
    const consider = (path: string, key: string, root: string): void => {
      if (this.tracked.has(path) || this.tracked.size >= this.o.maxSessions) return;
      let m: number;
      try { m = statSync(path).mtimeMs; } catch { return; }
      if (nowMs - m > this.o.endedMs) return;
      this.tracked.set(path, { key: key.slice(0, 128), path, status: null, projectId: null, lastEmit: 0, cwd: null, cwdAt: -Infinity, resolved: false, mtimeMs: m });
      void root;
    };
    for (const root of this.o.dirs) {
      let projDirs: import('node:fs').Dirent[];
      try { projDirs = readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const pd of projDirs) {
        if (!pd.isDirectory()) continue; // symlinks are never followed
        const pdir = join(root, pd.name);
        let entries: import('node:fs').Dirent[];
        try { entries = readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.jsonl')) consider(join(pdir, e.name), `claude:${basename(e.name, '.jsonl')}`, root);
        }
      }
    }
  }

  private tailFor(path: string): ClaudeLogTail | undefined {
    for (const [root, t] of this.tails) if (path.startsWith(root)) return t;
    return undefined;
  }

  /** One poll. Cheap: stats the tracked files; a directory walk only every `discoverMs`. */
  async tick(now: Date): Promise<CanonicalEventInput[]> {
    const nowMs = now.getTime();
    if (nowMs - this.lastDiscover >= this.o.discoverMs) { this.discover(nowMs); this.lastDiscover = nowMs; }
    const out: CanonicalEventInput[] = [];
    const ep = this.o.epoch();
    if (ep !== this.seenEpoch) { this.seenEpoch = ep; for (const t of this.tracked.values()) t.cwdAt = -Infinity; } // the project list changed: attribute again now
    const work = [...this.tracked.values()].map(async (t) => {
      let mtime: number;
      try { mtime = statSync(t.path).mtimeMs; } catch { mtime = -Infinity; }
      const age = nowMs - mtime;
      t.mtimeMs = mtime;
      const tail = this.tailFor(t.path);
      if (age > this.o.endedMs) {
        this.tracked.delete(t.path);
        tail?.forget(t.key);
        if (t.status !== null) out.push(sessionEnded(this.o.instance, t.key, now));
        return;
      }
      const status: 'working' | 'idle' = age <= this.o.workingMs ? 'working' : 'idle';
      if (!t.resolved || nowMs - t.cwdAt >= this.o.cwdTtlMs) {
        const cwd = readNewestCwd(t.path) ?? t.cwd;
        t.cwd = cwd; t.cwdAt = nowMs;
        const a = await this.o.attributor.attribute(cwd, nowMs);
        t.projectId = a.projectId; t.resolved = cwd !== null || t.resolved;
      }
      if (t.status !== status || t.lastEmit === 0 || t.emittedProject !== t.projectId || nowMs - t.lastEmit >= this.o.reobserveMs) {
        t.emittedProject = t.projectId;
        t.status = status; t.lastEmit = nowMs;
        out.push(sessionObserved({ instance: this.o.instance, key: t.key, status, projectId: t.projectId, at: now, priv: { cwd: t.cwd, log: basename(t.path), attribution: t.projectId ? 'matched' : 'unattributed' } }));
      }
      if (tail) {
        try {
          for (const e of tail.pollPath(t.key, t.path, this.o.instance, now)) out.push({ ...e, source: 'collector', sourceInstance: this.o.instance } as CanonicalEventInput);
        } catch { /* unreadable log: skip this round */ }
      }
    });
    await Promise.all(work);
    // Sub-agents of every live main (idle masters still have working sub-agents); ended masters end theirs.
    const parents: SubagentParent[] = [...this.tracked.values()].filter((t) => t.status !== null).map((t) => ({ key: t.key, file: t.path, projectId: t.projectId }));
    try { out.push(...this.subagents.tick(parents, now)); } catch { /* best effort */ }
    return out;
  }
}
