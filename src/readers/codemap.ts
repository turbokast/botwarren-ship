/**
 * Code map (OPT-IN, default OFF): the local half. While the owner has Code map switched on, this reads
 *   - the tracked file list of a project's repository (`git ls-files`, read-only, niced), only to derive at most 9 areas,
 *   - the last commit time of each area (`git log -1 -- <area>`, read-only, niced, cached for 30 minutes),
 *   - and, handed in by the session log reader one call at a time, the file path of a tool call the agent already observes,
 *     only to say which area it falls in. The path is dropped the moment that is known.
 * What can leave this process is built only from `AreaGroup`s that have been reduced to: an opaque index (1..9, handed out in the order of a
 * salted hash, so it carries no name or size information), a closed-enum kind and a staleness bucket. Folder names, file names, paths and file
 * counts stay in memory here (and in the owner's local `botwarren codemap` listing); they are never part of an event, a log line or a request.
 *
 * Off means off: nothing is read, nothing is kept in memory, and `areaOf` answers null before looking at its argument.
 */
import { execFile } from 'node:child_process';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { AREA_MAX, deriveUnits, groupAreas, groupOfPath, stalenessOf, unitIndex, type AreaGroup, type AreaKind, type CanonicalEventInput, type PublicArea, type Staleness } from '../vendor/core/contract.ts';
import { isInside, isWindowsPath } from '../pathmatch.ts';

export type GitRun = (cwd: string, args: string[], timeoutMs: number) => Promise<string | null>;

/** Read-only git, lowest CPU priority, never prompts, never takes optional locks. Null on any failure. */
export const runGit: GitRun = (cwd, args, timeoutMs) => new Promise((done) => {
  const child = execFile('git', ['-C', cwd, ...args], {
    timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  }, (err, stdout) => done(err ? null : stdout));
  try { if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_LOW); } catch { /* not supported here: run at normal priority */ }
});

const REBUILD_MS = 30 * 60_000;
const SAVE_MS = 10_000;
const MAX_GIT_UNITS = 40;
const BUDGET_MS = 90_000;
const sha = (...p: string[]) => createHash('sha256').update(p.join('\0')).digest('hex');

interface State { v: 1; salt: string; /** area key (a salted hash, not reversible without the salt) -> index */ assign: Record<string, number>; /** area key -> last edit seen (epoch ms) */ touched: Record<string, number> }

interface ProjectMap {
  id: string; root: string; groups: AreaGroup[]; index: Map<string, number>; keys: string[]; idx: number[]; commitMs: number[]; builtAt: number;
  sig: string; emittedAt: number;
}

export interface CodeMapOptions {
  stateFile: string;
  projects: () => { id: string; repoPaths: string[] }[];
  enabled: () => boolean;
  now?: () => number;
  git?: GitRun;
  instance: string;
  /** a fixed-code logger (never text) */
  log?: (msg: string) => void;
}

/** what the owner sees LOCALLY (names included): never sent anywhere */
export interface LocalAreaRow { i: number; kind: AreaKind; stale: Staleness; files: number; folders: string[] }

export class CodeMapService {
  private readonly o: CodeMapOptions;
  private readonly now: () => number;
  private readonly git: GitRun;
  private state: State | null = null;
  private dirtyAt = 0;
  private lastSave = 0;
  private readonly maps = new Map<string, ProjectMap>();
  private building = false;
  private readonly rootCache = new Map<string, string | null>();

  constructor(o: CodeMapOptions) { this.o = o; this.now = o.now ?? Date.now; this.git = o.git ?? runGit; }

  get enabled(): boolean { return this.o.enabled(); }

  private load(): State {
    if (this.state) return this.state;
    let s: State | null = null;
    try {
      const raw = JSON.parse(readFileSync(this.o.stateFile, 'utf8')) as Partial<State>;
      if (raw.v === 1 && typeof raw.salt === 'string' && raw.salt.length >= 16 && raw.assign && raw.touched) s = raw as State;
    } catch { /* first run, or unreadable: start fresh */ }
    this.state = s ?? { v: 1, salt: randomBytes(24).toString('hex'), assign: {}, touched: {} };
    return this.state;
  }

  private save(force = false): void {
    if (!this.state || this.dirtyAt === 0) return;
    const t = this.now();
    if (!force && t - this.lastSave < SAVE_MS) return;
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.o.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, this.o.stateFile);
      this.lastSave = t; this.dirtyAt = 0;
    } catch { this.o.log?.('code map: could not save its state file'); }
  }

  /** the owner turned Code map off: forget everything in memory (the state file only holds hashes and indices, and is kept so ids survive turning it on again) */
  clear(): void { this.save(true); this.maps.clear(); this.rootCache.clear(); this.state = null; }

  private keyOf(project: string, anchor: string): string { return createHmac('sha256', this.load().salt).update(`${project}\0${anchor}`).digest('hex').slice(0, 20); }

  /** hands out indices: kept for areas that had one, new areas take the lowest free index in the order of their salted key (so it says nothing about names or sizes) */
  private assign(project: string, keys: string[]): number[] {
    const st = this.load();
    const live = new Set(keys);
    const used = new Set<number>();
    const out: number[] = new Array(keys.length).fill(0);
    keys.forEach((k, n) => { const have = st.assign[k]; if (have && have >= 1 && have <= AREA_MAX && !used.has(have)) { used.add(have); out[n] = have; } });
    // a key that fell out of use frees its index for newcomers
    for (const [k, v] of Object.entries(st.assign)) if (!live.has(k) && used.has(v)) delete st.assign[k];
    const fresh = keys.map((k, n) => ({ k, n })).filter(({ n }) => out[n] === 0).sort((a, b) => (a.k < b.k ? -1 : 1));
    for (const { k, n } of fresh) {
      let i = 1; while (used.has(i)) i++;
      if (i > AREA_MAX) break;
      used.add(i); out[n] = i; st.assign[k] = i; this.dirtyAt = this.now();
    }
    void project;
    return out;
  }

  // ------------------------------------------------------------------ building a project's map

  private async build(p: { id: string; repoPaths: string[] }): Promise<ProjectMap | null> {
    const root = p.repoPaths[0];
    if (!root) return null;
    const list = await this.git(root, ['ls-files', '-z', '--cached'], 30_000);
    if (list === null) return null;
    const files = list.split('\0').filter((f) => f.length > 0);
    if (files.length === 0) return null;
    const groups = groupAreas(deriveUnits(files), AREA_MAX);
    if (groups.length === 0) return null;
    const keys = groups.map((g) => this.keyOf(p.id, g.anchor));
    const idx = this.assign(p.id, keys);
    // last commit time per unit, newest unit first; bounded in count and in total time
    const started = this.now();
    const times = new Map<string, number>();
    let calls = 0;
    for (const g of groups) for (const u of g.units) {
      if (calls >= MAX_GIT_UNITS || this.now() - started > BUDGET_MS) break;
      calls++;
      const spec = u === '' ? ':(glob,top)*' : `:(literal)${u}/`;
      const out = await this.git(root, ['log', '-1', '--format=%ct', '--', spec], 15_000);
      const sec = out === null ? NaN : Number(out.trim());
      if (Number.isFinite(sec) && sec > 0) times.set(u, sec * 1000);
    }
    const commitMs = groups.map((g) => Math.max(0, ...g.units.map((u) => times.get(u) ?? 0)));
    return { id: p.id, root, groups, index: unitIndex(groups), keys, idx, commitMs, builtAt: this.now(), sig: '', emittedAt: 0 };
  }

  private staleOf(m: ProjectMap, gi: number): Staleness {
    const t = Math.max(m.commitMs[gi] ?? 0, this.load().touched[m.keys[gi]!] ?? 0);
    return t > 0 ? stalenessOf(this.now() - t) : 'unknown';
  }

  private publicAreas(m: ProjectMap): PublicArea[] {
    return m.groups.map((g, gi) => ({ i: m.idx[gi] ?? 0, kind: g.kind, stale: this.staleOf(m, gi) })).filter((a) => a.i >= 1).sort((a, b) => a.i - b.i);
  }

  /**
   * One round: (re)builds a project's map when it is older than 30 minutes, and returns a `project.areas` event for every project whose
   * public view changed. Cheap when nothing changed (no git). Does nothing at all while Code map is off.
   */
  async refresh(): Promise<CanonicalEventInput[]> {
    if (!this.enabled) { if (this.maps.size) this.clear(); return []; }
    const out: CanonicalEventInput[] = [];
    if (!this.building) {
      this.building = true;
      try {
        const projects = this.o.projects();
        for (const p of projects) {
          const have = this.maps.get(p.id);
          if (have && this.now() - have.builtAt < REBUILD_MS && have.root === p.repoPaths[0]) continue;
          const next = await this.build(p);
          if (!this.enabled) { this.clear(); return []; } // switched off while git ran: drop it
          if (next) { if (have) { next.sig = have.sig; next.emittedAt = have.emittedAt; } this.maps.set(p.id, next); }
          else if (!have) this.o.log?.('code map: a project has no readable git history yet');
        }
        for (const id of [...this.maps.keys()]) if (!projects.some((p) => p.id === id)) this.maps.delete(id);
      } finally { this.building = false; }
    }
    const at = new Date(this.now());
    for (const m of this.maps.values()) {
      const areas = this.publicAreas(m);
      if (areas.length === 0) continue;
      const sig = JSON.stringify(areas);
      if (sig === m.sig && this.now() - m.emittedAt < 6 * 3600_000) continue;
      m.sig = sig; m.emittedAt = this.now();
      const iso = at.toISOString();
      out.push({
        schemaVersion: 1, eventId: `areas-${sha(m.id, sig, iso).slice(0, 32)}`, source: 'collector', sourceInstance: this.o.instance, sourceEventId: `areas:${m.id}:${iso}`.slice(0, 256),
        occurredAt: iso, observedAt: iso, type: 'project.areas', projectId: m.id as never, areas,
      });
    }
    this.save();
    return out;
  }

  // ------------------------------------------------------------------ resolving one tool call's path

  /** nearest ancestor directory of `cwd` that holds a `.git` entry (a repository or a worktree root); cached */
  private rootOf(cwd: string): string | null {
    if (this.rootCache.has(cwd)) return this.rootCache.get(cwd)!;
    let dir = cwd, found: string | null = null;
    const win = isWindowsPath(cwd), pp = win ? win32 : posix;
    for (let i = 0; i < 40; i++) {
      try { if (existsSync(pp.join(dir, '.git'))) { found = dir; break; } } catch { /* ignore */ }
      const up = pp.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (this.rootCache.size > 200) this.rootCache.clear();
    this.rootCache.set(cwd, found);
    return found;
  }

  /**
   * The area index of one observed tool call, or null (off, unknown project, a path outside the repository, nothing mapped yet).
   * `rawPath` is read here and nowhere else; only the index comes back. An edit also counts as "changed now" for that area.
   */
  areaOf(projectId: string | null, cwd: string | null, rawPath: string, edit: boolean): number | null {
    if (!this.enabled || projectId === null) return null;
    const m = this.maps.get(projectId);
    if (!m || typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 1024 || rawPath.includes('\0')) return null;
    const win = isWindowsPath(m.root) || (cwd !== null && isWindowsPath(cwd));
    const pp = win ? win32 : posix;
    const abs = pp.isAbsolute(rawPath) ? rawPath : pp.resolve(cwd ?? m.root, rawPath);
    const roots = [cwd ? this.rootOf(cwd) : null, m.root, ...(this.o.projects().find((p) => p.id === projectId)?.repoPaths ?? [])].filter((r): r is string => !!r);
    for (const r of roots) {
      if (!isInside(abs, r)) continue;
      const rel = pp.relative(r, abs).split(/[\\/]/).join('/');
      if (rel === '' || rel.startsWith('..')) continue;
      const gi = groupOfPath(m.index, m.groups, rel);
      if (gi === null) return null;
      const i = m.idx[gi];
      if (!i) return null;
      if (edit) { this.load().touched[m.keys[gi]!] = this.now(); this.dirtyAt = this.now(); }
      return i;
    }
    return null;
  }

  // ------------------------------------------------------------------ the owner's local view (names included; never sent)

  local(): { project: string; areas: LocalAreaRow[] }[] {
    if (!this.enabled) return [];
    return [...this.maps.values()].map((m) => ({
      project: m.id,
      areas: m.groups.map((g, gi) => ({ i: m.idx[gi] ?? 0, kind: g.kind, stale: this.staleOf(m, gi), files: g.files, folders: g.units.map((u) => (u === '' ? '(top-level files)' : u)) })).filter((a) => a.i >= 1).sort((a, b) => a.i - b.i),
    }));
  }

  /** counts only, safe for status output and logs */
  status(): { on: boolean; projects: number; areas: number } {
    if (!this.enabled) return { on: false, projects: 0, areas: 0 };
    return { on: true, projects: this.maps.size, areas: [...this.maps.values()].reduce((n, m) => n + m.idx.filter((i) => i >= 1).length, 0) };
  }
}

/** a `join` re-export so tests can place the state file without importing node:path twice */
export const codeMapStateFile = (dataDir: string): string => join(dataDir, 'private', 'codemap.json');
