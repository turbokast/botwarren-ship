/**
 * Gemini CLI adapter. Reads NO file content at all.
 *
 * Gemini CLI keeps chats under  ~/.gemini/tmp/<project_hash>/chats/session-*.json(l)  where <project_hash> is the
 * SHA-256 (hex) of the project root path (documented by geminicli.com session-management docs / its source; UNVERIFIED
 * here, no live recording; Windows path spelling is also unverified). We exploit that: for each CONFIGURED repo path we
 * compute the hash ourselves, look only at the file NAMES and write times in that folder, and attribute by the hash.
 * Sessions of folders that are not configured projects are never seen, and message content is never opened.
 *
 * State (inferred): written within 20 s -> working; quiet up to 30 min -> idle; longer -> ended.
 * NOTE: individuals were moved to Antigravity CLI on 2026-06-18 (research doc); that tool is a separate, later adapter.
 */
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { ADAPTER_API_VERSION, type Adapter, type AdapterContext, type AdapterManifest, type DetectEnv, type Detection, type Observation } from './api.ts';
import type { Host } from '../paths.ts';
import { isWindowsPath } from '../pathmatch.ts';

const WORKING_MS = 20_000;
const ENDED_MS = 30 * 60_000;
const REOBSERVE_MS = 120_000;

export const projectHash = (root: string): string => createHash('sha256').update(root).digest('hex');

/** Hash spellings tried for one configured path (as written, without a trailing separator). */
export function hashCandidates(repoPath: string): string[] {
  const trimmed = repoPath.length > 1 ? repoPath.replace(/[\\/]+$/, '') : repoPath;
  const set = new Set([projectHash(trimmed)]);
  if (isWindowsPath(trimmed)) { set.add(projectHash(trimmed.replace(/\//g, '\\'))); set.add(projectHash(trimmed.replace(/\\/g, '/'))); }
  return [...set];
}

export const geminiRoot = (host: Host): string => {
  const home = host.platform === 'win32' ? (host.env.USERPROFILE ?? host.home) : host.home;
  return (host.platform === 'win32' ? win32 : posix).join(home, '.gemini', 'tmp');
};

interface Seen { status: 'working' | 'idle'; lastEmit: number; project: string }

export class GeminiCliAdapter implements Adapter {
  readonly manifest: AdapterManifest;
  private readonly seen = new Map<string, Seen>();
  private readonly root: string;
  constructor(host: Host) {
    this.root = geminiRoot(host);
    this.manifest = {
      id: 'gemini-cli', apiVersion: ADAPTER_API_VERSION, version: '1.0.0', platforms: ['win32', 'darwin', 'linux'],
      reads: [{ kind: 'dir', target: this.root, keeps: 'only file names and write times of chat files, in the folder named by the hash of each configured project path. File contents are never opened.' }],
      capabilities: { state: true, toolCategory: false, errors: false, subagents: false, tokens: false, hierarchy: false },
      upstream: { name: 'Gemini CLI', tested: 'documented layout only (~/.gemini/tmp/<hash>/chats)', verification: 'unverified' },
      summary: 'Gemini CLI sessions in your configured projects (from chat file names and write times only).',
    };
  }

  async detect(env: DetectEnv): Promise<Detection> {
    if (env.exists(this.root)) return { found: true, confidence: 'medium', note: 'Gemini CLI data folder present' };
    return env.hasCommand('gemini') ? { found: true, confidence: 'low', note: 'gemini is installed; no chats yet' } : { found: false, confidence: 'high' };
  }

  async poll(ctx: AdapterContext, now: Date): Promise<Observation[]> {
    const nowMs = now.getTime();
    const sep = ctx.host.platform === 'win32' ? win32 : posix;
    const out: Observation[] = [];
    const present = new Set<string>();
    for (const p of ctx.projects) {
      const hashes = new Set(p.repoPaths.flatMap(hashCandidates));
      for (const h of hashes) {
        const dir = sep.join(this.root, h, 'chats');
        for (const e of ctx.fs.list(dir)) {
          if (!e.isFile || !/^session-[A-Za-z0-9._-]{1,120}\.jsonl?$/.test(e.name)) continue;
          const st = ctx.fs.stat(sep.join(dir, e.name));
          if (!st || nowMs - st.mtimeMs > ENDED_MS) continue;
          const stem = e.name.replace(/\.jsonl?$/, '');
          const key = `gemini:${stem}`.slice(0, 128);
          present.add(key);
          const status = nowMs - st.mtimeMs <= WORKING_MS ? 'working' : 'idle';
          const prev = this.seen.get(key);
          if (prev && prev.status === status && nowMs - prev.lastEmit < REOBSERVE_MS) continue;
          this.seen.set(key, { status, lastEmit: nowMs, project: p.id });
          out.push({
            kind: 'session', key, tool: 'gemini-cli', harness: 'unknown', status, projectId: p.id, certainty: 'inferred',
            correlate: [{ type: 'gemini-session', id: stem }], local: { log: e.name },
          });
        }
      }
    }
    for (const key of [...this.seen.keys()]) {
      if (present.has(key)) continue;
      this.seen.delete(key);
      out.push({ kind: 'session.ended', key, reason: 'unknown' });
    }
    return out;
  }
}
