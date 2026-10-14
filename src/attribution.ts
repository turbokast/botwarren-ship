/**
 * Project attribution for a session cwd. Never reads file contents; only compares paths and
 * (read-only) `git remote get-url origin`. Unknown cwds stay unattributed and are never published.
 *
 *  1. Same normalised git remote as a configured project's repo path -> that project (covers other
 *     clones / worktrees on other drives).
 *  2. Else cwd inside a configured repo path (longest, most specific path wins).
 *  3. Else unattributed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normaliseRemote } from './vendor/core/contract.ts';
import { isInside, normalisePath, pathDepth } from './pathmatch.ts';

const run = promisify(execFile);

export type GitRemoteFn = (dir: string) => Promise<string | null>;

/** `git -C <dir> remote get-url origin`, normalised to host/namespace/repo (credentials stripped). */
export const gitRemote: GitRemoteFn = async (dir) => {
  try {
    const { stdout } = await run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 3000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return normaliseRemote(stdout);
  } catch { return null; }
};

export interface ProjectRef { id: string; repoPaths: string[] }
export interface Attribution { projectId: string | null; method: 'cwd_registry' | 'none'; via: 'remote' | 'path' | null }

const TTL_MS = 10 * 60_000;
const MAX_CACHE = 500;

export class ProjectAttributor {
  private readonly projects: ProjectRef[];
  private readonly remote: GitRemoteFn;
  private readonly cache = new Map<string, { v: string | null; at: number }>();
  private projectRemotes: Map<string, Set<string>> | null = null;

  constructor(projects: ProjectRef[], remote: GitRemoteFn = gitRemote) { this.projects = projects; this.remote = remote; }

  /** the project list changed (a project was shown or hidden): forget the remotes worked out for the old list */
  reset(): void { this.projectRemotes = null; }

  private async remoteOf(dir: string, now: number): Promise<string | null> {
    const hit = this.cache.get(dir);
    if (hit && now - hit.at < TTL_MS) return hit.v;
    const v = await this.remote(dir);
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(dir, { v, at: now });
    return v;
  }

  private async remotesByProject(now: number): Promise<Map<string, Set<string>>> {
    if (this.projectRemotes) return this.projectRemotes;
    const m = new Map<string, Set<string>>();
    for (const p of this.projects) {
      const s = new Set<string>();
      for (const rp of p.repoPaths) { const r = await this.remoteOf(rp, now); if (r) s.add(r); }
      m.set(p.id, s);
    }
    this.projectRemotes = m; // configured repos' remotes do not change while the agent runs
    return m;
  }

  private pathMatch(cwd: string): { id: string; depth: number } | null {
    let best: { id: string; depth: number } | null = null;
    for (const p of this.projects) for (const rp of p.repoPaths) {
      if (isInside(cwd, rp)) { const depth = pathDepth(rp); if (!best || depth > best.depth) best = { id: p.id, depth }; }
    }
    return best;
  }

  async attribute(cwd: string | null | undefined, now: number = Date.now()): Promise<Attribution> {
    if (!cwd || normalisePath(cwd) === null) return { projectId: null, method: 'none', via: null };
    const byPath = this.pathMatch(cwd);
    const cwdRemote = await this.remoteOf(cwd, now);
    if (cwdRemote) {
      const remotes = await this.remotesByProject(now);
      const matches = this.projects.filter((p) => remotes.get(p.id)?.has(cwdRemote));
      if (matches.length) {
        const pick = matches.find((p) => p.id === byPath?.id) ?? matches[0]!;
        return { projectId: pick.id, method: 'cwd_registry', via: 'remote' };
      }
    }
    if (byPath) return { projectId: byPath.id, method: 'cwd_registry', via: 'path' };
    return { projectId: null, method: 'none', via: null };
  }
}
