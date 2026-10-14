/**
 * `botwarren connect`: the one way to connect this computer to a ship, for everyone.
 *
 *  - with a CLAIM TOKEN (the personalised command on botwarren.com/get puts it in BOTWARREN_CLAIM): exchange it once for this ship's
 *    own secret, save it (user-only file), write the config, start the agent. The token is short-lived, single-use and scoped to
 *    claiming one ship; it is never printed, logged or written to disk, and a leak from shell history after use is worthless.
 *  - without one: the device-code flow (`botwarren pair`): a short code is shown and the browser opens on the approval page when
 *    this computer has a desktop; on a headless machine the code and address are printed once.
 *
 * Exit codes (the installers rely on them): 0 connected, 1 failed, 2 bad usage, 3 already connected (nothing to do).
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { configPath, currentHost, defaultSecretFile } from './paths.ts';
import { DISCONNECTED_NOTE, PairedResponse, osName, parsePairFlags, runPair, saveAndStart, shipUrlOk, siteOrigin, type PairDeps } from './pair.ts';
import { VERSION } from './version.ts';

export const CLAIM_SHAPE = /^bwc_[A-Za-z0-9_-]{20,80}$/;
const ErrorBody = z.object({ error: z.string().max(60) }).passthrough();

export interface ConnectFlags { claim: string | null; rest: string[] }
/** `--claim <token>` is accepted for convenience (it shows in the process list; the environment variable does not) */
export function splitClaim(argv: string[]): ConnectFlags | string {
  const rest: string[] = []; let claim: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--claim') { const v = argv[++i]; if (!v || v.startsWith('--')) return '--claim needs a value'; claim = v; } else rest.push(argv[i]!);
  }
  return { claim, rest };
}

export function archName(arch: string): 'x64' | 'arm64' | 'other' { return arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : 'other'; }

export async function runConnect(argv: string[], deps: PairDeps & { arch?: string } = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stdout.write(s); });
  const err = deps.err ?? ((s: string) => { process.stderr.write(s); });
  const host = deps.host ?? currentHost();
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const split = splitClaim(argv);
  if (typeof split === 'string') { err(`${split}\nusage: botwarren connect [--no-open] [--no-start] [--url <site>]   (a claim command from botwarren.com/get sets BOTWARREN_CLAIM)\n`); return 2; }
  const token = split.claim ?? (env.BOTWARREN_CLAIM?.trim() || null);
  if (token !== null && !CLAIM_SHAPE.test(token)) { err('That claim command looks cut off or changed. Copy it again from https://botwarren.com/get.\n'); return 2; }

  const cfgFile = env.BOTWARREN_SHIP_CONFIG ?? configPath(host);
  let existing: Record<string, unknown> | null = null;
  if (existsSync(cfgFile)) {
    try { existing = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>; }
    catch { err(`The config file ${cfgFile} is not valid JSON, so it was left alone. Fix or delete it, then connect again.\n`); return 1; }
  }
  const secretFile = typeof existing?.secretFile === 'string' && existing.secretFile ? existing.secretFile : defaultSecretFile(host);
  const connected = existing !== null && typeof existing.shipId === 'string' && existsSync(secretFile);
  if (token === null) {
    if (connected) { out(`This computer is already connected to ship "${String(existing!.shipId)}". Manage it at https://botwarren.com/account. To connect it to a different ship, get a new command at https://botwarren.com/get.\n`); return 3; }
    return runPair(split.rest, deps); // device code: a short code, the browser opens when there is a desktop
  }

  const pf = parsePairFlags(split.rest);
  if (typeof pf === 'string') { err(`${pf}\n`); return 2; }
  const site = siteOrigin(pf.site, env, typeof existing?.replicaUrl === 'string' ? existing.replicaUrl : null);
  if (!site) { err('The site address must be https (http is only allowed for localhost).\n'); return 2; }

  let paired: z.infer<typeof PairedResponse>;
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${site}/api/claim/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      body: JSON.stringify({ token, os: osName(host), arch: archName(deps.arch ?? process.arch), agent: VERSION }), // the OS kind, CPU kind and agent version: nothing about this computer's name or files
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 429) { err('Too many attempts from here. Wait a few minutes and try again.\n'); return 1; }
    if (res.status === 400 || res.status === 409) {
      const code = ErrorBody.safeParse(body);
      if (res.status === 409 || (code.success && code.data.error === 'ship_unavailable')) err('That ship is not available any more. Get a new command at https://botwarren.com/get.\n');
      else err('This command has expired or was already used (they work once, for 30 minutes). Get a fresh one at https://botwarren.com/get.\n');
      return 1;
    }
    if (!res.ok) { err(`Could not connect (HTTP ${res.status}). Please try again in a little while.\n`); return 1; }
    const ok = PairedResponse.safeParse(body);
    if (!ok.success || !shipUrlOk(ok.data.base_url, ok.data.ship_id, site)) { err('The server sent an answer this version does not trust, so nothing was saved. Get a new command at https://botwarren.com/get.\n'); return 1; }
    paired = ok.data;
  } catch {
    err(`Could not reach ${site}. Check your internet connection, then run the same command again (it has not been used up).\n`);
    return 1;
  }
  const repos = pf.repos.map((r) => resolve(deps.cwd ?? process.cwd(), r)).filter((r) => existsSync(r) && statSync(r).isDirectory());
  const projectsKnown = Array.isArray(existing?.projects) && (existing!.projects as unknown[]).length > 0;
  return saveAndStart(paired, { cfgFile, existing, projectsKnown, repos, name: pf.name, noStart: pf.noStart, host, deps, now, via: 'claim' });
}

/**
 * The website revoked this computer (or the ship was removed): forget the secret and the ship, keep everything else, and leave a note
 * `botwarren status` can show. The agent then idles until it is connected again. Never throws.
 */
export function wipeConnection(cfgFile: string, secretFile: string, reason: string, now: Date = new Date()): void {
  try { rmSync(secretFile, { force: true }); } catch { /* ignore */ }
  try { if (existsSync(cfgFile)) renameSync(cfgFile, join(dirname(cfgFile), 'config.disconnected.json')); } catch { /* ignore */ }
  try { writeFileSync(join(dirname(cfgFile), DISCONNECTED_NOTE), `${now.toISOString()} ${reason}\n`, { mode: 0o600 }); } catch { /* ignore */ }
}
