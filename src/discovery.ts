/**
 * Zero-config project discovery. The agent already sees the working folder (cwd) of every coding session; a folder inside a git
 * checkout is a PROJECT. Nothing is configured by hand: the owner chooses on the website which noticed projects their ship shows.
 *
 * Privacy contract (tested with canary paths in test/discovery.test.ts):
 *  - the local path of a project NEVER leaves this computer: it is kept only in the user-only discovery file next to the agent's
 *    other private data and used to attribute sessions;
 *  - what is reported to the OWNER-ONLY channel (never to a public store) is an opaque key (`p-` + 8 hex from a per-install salted
 *    HMAC, so it cannot be reversed or compared across installs) and a display name: the repository name from the git remote, else
 *    the folder's own name, passed through the public DisplayText charset. A person can turn names off (`discovery.names: false`):
 *    then only "Project N" is reported;
 *  - a project is published only when the owner switches it on from the website (`applyChoices`); the cloud can only choose among
 *    keys this module itself produced, so it cannot make the agent look at anything else.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { DisplayText, MAX_DISCOVERED_PROJECTS, ProjectKey, type ProjectChoice } from './vendor/core/contract.ts';
import { isWindowsPath, normalisePath } from './pathmatch.ts';
import { prettifyFolderName } from './names.ts';
import type { GitRemoteFn } from './attribution.ts';

export interface DiscoveredProject {
  id: string;
  /** safe display name (owner-only) */
  name: string;
  /** git checkout root, LOCAL ONLY: never sent anywhere */
  root: string;
  /** normalised git remote, LOCAL ONLY (used to recognise the same repository elsewhere on this computer) */
  remote: string | null;
  firstSeen: string;
  lastSeen: string;
}
export interface ProjectState { show: boolean; name?: string }
interface FileShape { v: 1; salt: string; projects: DiscoveredProject[]; choices: Record<string, ProjectState> }

/** a name that passes the public DisplayText rules: bad characters become spaces; nothing usable becomes "Project" */
export function safeDisplayName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9 '&.-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[^A-Za-z0-9]+/, '').slice(0, 40).trim();
  const ok = DisplayText.safeParse(cleaned);
  return ok.success ? ok.data : 'Project';
}

/** repository name from a normalised remote ("host/ns/repo" -> "Repo") */
export function nameFromRemote(remote: string): string | null {
  const last = remote.split('/').filter(Boolean).at(-1);
  return last ? prettifyFolderName(last) : null;
}

export interface DiscoveryOptions {
  file: string;
  home: string;
  gitRemote: GitRemoteFn;
  /** does this path exist (injectable for tests) */
  exists?: (p: string) => boolean;
  now?: () => number;
  /** false: report "Project N" instead of repository names */
  sendNames?: boolean;
}

export class ProjectDiscovery {
  private readonly o: Required<Omit<DiscoveryOptions, 'sendNames'>> & { sendNames: boolean };
  private state: FileShape;
  private dirty = false;
  private readonly rootCache = new Map<string, { root: string | null; at: number }>();
  private readonly lastTouch = new Map<string, number>();
  private readonly pending = new Set<string>();

  constructor(o: DiscoveryOptions) {
    this.o = { exists: (p) => { try { return existsSync(p); } catch { return false; } }, now: Date.now, sendNames: true, ...o };
    this.state = this.load();
  }

  private load(): FileShape {
    try {
      const raw = JSON.parse(readFileSync(this.o.file, 'utf8')) as Partial<FileShape>;
      if (raw.v === 1 && typeof raw.salt === 'string' && Array.isArray(raw.projects) && raw.choices && typeof raw.choices === 'object') {
        const projects = raw.projects.filter((p): p is DiscoveredProject => !!p && ProjectKey.safeParse(p.id).success && typeof p.root === 'string' && typeof p.name === 'string').slice(0, MAX_DISCOVERED_PROJECTS);
        const choices: Record<string, ProjectState> = {};
        for (const [k, v] of Object.entries(raw.choices)) if (ProjectKey.safeParse(k).success && v && typeof v.show === 'boolean') choices[k] = { show: v.show, ...(typeof v.name === 'string' && DisplayText.safeParse(v.name).success ? { name: v.name } : {}) };
        return { v: 1, salt: raw.salt, projects, choices };
      }
    } catch { /* first run, or unreadable: start fresh */ }
    return { v: 1, salt: randomBytes(16).toString('hex'), projects: [], choices: {} };
  }

  /** atomic, user-only write (the file holds local paths) */
  flush(): void {
    if (!this.dirty && existsSync(this.o.file)) return;
    try {
      mkdirSync(dirname(this.o.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.o.file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch { /* not supported */ }
      renameSync(tmp, this.o.file);
      this.dirty = false;
    } catch { /* retried at the next flush */ }
  }

  /** The git checkout containing `cwd`, never the home directory or a file system root. */
  findRoot(cwd: string): string | null {
    const norm = normalisePath(cwd);
    if (norm === null) return null;
    const win = isWindowsPath(cwd);
    const j = win ? win32.join : posix.join;
    const parent = win ? win32.dirname : posix.dirname;
    const home = normalisePath(this.o.home);
    let d = win ? win32.normalize(cwd).replace(/[\\/]+$/, '') || cwd : posix.normalize(cwd).replace(/\/+$/, '') || '/';
    for (let i = 0; i < 40; i++) {
      const dn = normalisePath(d);
      if (dn === null) return null;
      if (home !== null && dn === home) return null; // a dotfiles repo in $HOME must not make everything below it a project
      const up = parent(d);
      if (up === d) return null; // reached the file system root
      if (this.o.exists(j(d, '.git'))) return d;
      d = up;
    }
    return null;
  }

  private keyFor(root: string, remote: string | null): string {
    const basis = remote ? `remote\0${remote}` : `path\0${normalisePath(root) ?? root}`;
    return `p-${createHmac('sha256', this.state.salt).update(basis).digest('hex').slice(0, 8)}`;
  }

  /**
   * Notes that a session ran in `cwd`. Returns the project when it is inside a git checkout (creating it the first time), else null.
   * Cheap on the hot path: repeated calls for the same folder only touch an in-memory cache.
   */
  async note(cwd: string | null | undefined): Promise<DiscoveredProject | null> {
    if (!cwd) return null;
    const now = this.o.now();
    const hit = this.rootCache.get(cwd);
    let root: string | null;
    if (hit && now - hit.at < 10 * 60_000) root = hit.root;
    else {
      root = this.findRoot(cwd);
      if (this.rootCache.size > 500) this.rootCache.clear();
      this.rootCache.set(cwd, { root, at: now });
    }
    if (root === null) return null;
    const known = this.state.projects.find((p) => normalisePath(p.root) === normalisePath(root!));
    if (known) {
      if (now - (this.lastTouch.get(known.id) ?? 0) > 60_000) { this.lastTouch.set(known.id, now); known.lastSeen = new Date(now).toISOString(); this.dirty = true; }
      return known;
    }
    if (this.pending.has(root)) return null;
    this.pending.add(root);
    try {
      const remote = await this.o.gitRemote(root);
      const id = this.keyFor(root, remote);
      const same = this.state.projects.find((p) => p.id === id); // the same repository checked out in a second folder
      if (same) { same.lastSeen = new Date(now).toISOString(); this.dirty = true; return same; }
      const idx = this.state.projects.length + 1;
      const raw = this.o.sendNames ? (remote ? nameFromRemote(remote) : null) ?? prettifyFolderName(root) ?? '' : `Project ${idx}`;
      const iso = new Date(now).toISOString();
      const p: DiscoveredProject = { id, name: safeDisplayName(raw), root, remote, firstSeen: iso, lastSeen: iso };
      if (this.state.projects.length >= MAX_DISCOVERED_PROJECTS) this.evict();
      this.state.projects.push(p);
      this.dirty = true;
      return p;
    } finally { this.pending.delete(root); }
  }

  /** drop the project seen longest ago that the owner never chose to show */
  private evict(): void {
    const candidates = this.state.projects.filter((p) => !this.state.choices[p.id]?.show).sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
    const gone = candidates[0] ?? this.state.projects[0];
    if (gone) this.state.projects = this.state.projects.filter((p) => p !== gone);
  }

  list(): readonly DiscoveredProject[] { return this.state.projects; }
  /** what the OWNER-ONLY report may carry: keys and display names, nothing else */
  report(): { id: string; name: string }[] {
    return [...this.state.projects].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, MAX_DISCOVERED_PROJECTS).map((p) => ({ id: p.id, name: p.name }));
  }
  choiceOf(id: string): ProjectState | undefined { return this.state.choices[id]; }

  /** the projects currently shown, in a stable order (first noticed first) */
  shown(): (DiscoveredProject & { publicName: string })[] {
    return this.state.projects.filter((p) => this.state.choices[p.id]?.show === true).map((p) => ({ ...p, publicName: this.state.choices[p.id]?.name ?? p.name }));
  }

  /**
   * Applies the owner's choices from the website. Only keys this module discovered are honoured; everything else is ignored.
   * Returns whether anything changed (the caller then rebuilds the public manifest).
   */
  applyChoices(choices: ProjectChoice[]): boolean {
    const known = new Set(this.state.projects.map((p) => p.id));
    let changed = false;
    for (const c of choices) {
      if (!known.has(c.id)) continue;
      const cur = this.state.choices[c.id];
      const next: ProjectState = { show: c.show, ...(c.name !== undefined ? { name: c.name } : {}) };
      if (!cur || cur.show !== next.show || cur.name !== next.name) { this.state.choices[c.id] = next; changed = true; }
    }
    if (changed) { this.dirty = true; this.flush(); }
    return changed;
  }
}

/** the file inside the agent's private data folder */
export const discoveryFile = (dataDir: string): string => join(dataDir, 'private', 'discovery.json');
