/**
 * `botwarren pair`: connects this computer to a ship through the website, with no secret to copy. Device-code pairing
 * (RFC 8628 in spirit):
 *
 *   1. POST <site>/api/pair/start  -> a secret device_code (only this process holds it) and a short code to show the person
 *   2. print the code and the pairing page, open the browser on it (the same validated opener `botwarren login` uses)
 *   3. poll POST <site>/api/pair/poll every `interval` seconds, honouring slow_down, until the person approves on the website
 *   4. the answer carries the ship id, the ship URL and a freshly minted ship secret, ONCE: it goes into the user-only secret
 *      file, the config is written, the agent is (re)started and publishes with the 30 s minimum delay for the first minutes
 *
 * The secret is never printed and never leaves the process except into the secret file. The server only checks hashes.
 * Re-running the command re-pairs: the website mints a new secret and the old one stops working.
 */
import { spawn, execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { configPath, currentHost, defaultSecretFile, type Host } from './paths.ts';
import { defaultPublicName, resolveConfig } from './config.ts';
import { systemOpener, validateLoginUrl, type Opener } from './login.ts';
import { onboardingUntilIso } from './onboarding.ts';
import { VERSION } from './version.ts';

const SITE_DEFAULT = 'https://botwarren.com';
const StartResponse = z.object({
  device_code: z.string().min(20).max(200),
  user_code: z.string().min(4).max(20).regex(/^[A-Z0-9-]+$/),
  verification_uri: z.string().min(1).max(512),
  verification_uri_complete: z.string().min(1).max(512).optional(),
  interval: z.number().int().min(1).max(60).default(5),
  expires_in: z.number().int().min(30).max(3600).default(600),
});
const PairedResponse = z.object({
  ship_id: z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/),
  ship_name: z.string().max(80).optional(),
  secret: z.string().min(16).max(200).regex(/^[A-Za-z0-9_-]+$/),
  base_url: z.string().url().max(300),
});
const ErrorResponse = z.object({ error: z.string().max(60), interval: z.number().int().min(1).max(120).optional() });

export interface PairDeps {
  fetchImpl?: typeof fetch;
  opener?: Opener;
  out?: (s: string) => void;
  err?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  host?: Host;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** nearest git checkout at or above a folder (default: look for .git) */
  findRepo?: (dir: string) => string | null;
  /** ask a question (only when there is a terminal) */
  prompt?: (question: string) => Promise<string>;
  /** true when a person can answer prompts */
  interactive?: boolean;
  /** lock a file down to the current user (Windows ACL); default: icacls on Windows, nothing elsewhere */
  restrictFile?: (path: string) => Promise<void>;
  /** make a running agent pick up the new config and secret, or start one: 'restarted' | 'started' | 'manual' */
  startAgent?: (configFile: string) => Promise<'restarted' | 'started' | 'manual'>;
  /** does the local agent answer yet? */
  agentUp?: (port: number) => Promise<boolean>;
  timeoutMs?: number;
}

export interface PairFlags { noOpen: boolean; noStart: boolean; site: string | null; repos: string[]; name: string | null }

export function parsePairFlags(flags: string[]): PairFlags | string {
  const out: PairFlags = { noOpen: false, noStart: false, site: null, repos: [], name: null };
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    if (f === '--no-open') out.noOpen = true;
    else if (f === '--no-start') out.noStart = true;
    else if (f === '--url' || f === '--repo' || f === '--name') {
      const v = flags[++i];
      if (!v || v.startsWith('--')) return `${f} needs a value`;
      if (f === '--url') out.site = v; else if (f === '--repo') out.repos.push(v); else out.name = v;
    } else return `unknown option ${f}`;
  }
  return out;
}

/** The website origin to pair with: --url, else $BOTWARREN_SITE_URL, else the apex of the configured ship, else botwarren.com. https only (http for localhost). */
export function siteOrigin(flag: string | null, env: Record<string, string | undefined>, existingReplicaUrl: string | null): string | null {
  const raw = flag ?? env.BOTWARREN_SITE_URL ?? (existingReplicaUrl ? apexOf(existingReplicaUrl) : SITE_DEFAULT);
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.username || u.password) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return u.origin;
}
/** a ship's own host (https://<ship>.<site>) -> the site itself; anything else is left alone (local testing) */
function apexOf(replicaUrl: string): string {
  try { const u = new URL(replicaUrl); return u.hostname.endsWith('.botwarren.com') ? 'https://botwarren.com' : u.origin; } catch { return SITE_DEFAULT; }
}

/** The ship URL the server hands back must be this site's own ship host (or the same origin when testing locally). */
export function shipUrlOk(base: string, shipId: string, site: string): boolean {
  let b: URL; let s: URL;
  try { b = new URL(base); s = new URL(site); } catch { return false; }
  if (b.username || b.password || b.search || b.hash || b.pathname !== '/') return false;
  if (b.origin === s.origin) return ['127.0.0.1', 'localhost', '[::1]'].includes(b.hostname);
  const apex = s.hostname.replace(/^www\./, '');
  return b.protocol === 'https:' && b.hostname === `${shipId}.${apex}` && b.port === s.port;
}

function osName(host: Host): 'windows' | 'macos' | 'linux' | 'other' {
  return host.platform === 'win32' ? 'windows' : host.platform === 'darwin' ? 'macos' : host.platform === 'linux' ? 'linux' : 'other';
}

function defaultFindRepo(dir: string): string | null {
  let d = resolve(dir);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

const defaultRestrict = (path: string): Promise<void> => new Promise((done) => {
  if (process.platform !== 'win32') return done();
  const user = process.env.USERNAME;
  if (!user) return done();
  execFile('icacls.exe', [path, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true }, () => done());
});

const run = (cmd: string, args: string[]): Promise<boolean> => new Promise((done) => {
  try { execFile(cmd, args, { windowsHide: true, timeout: 15_000 }, (e) => done(!e)); } catch { done(false); }
});

/** Restart the installed service for this OS, else start the agent detached. Best effort: 'manual' means the person must start it. */
export const defaultStartAgent = (configFile: string): Promise<'restarted' | 'started' | 'manual'> => (async () => {
  // the service names of the current installer first, then the zip installer's
  if (process.platform === 'linux') for (const unit of ['botwarren.service', 'botwarren-ship.service']) if (await run('systemctl', ['--user', 'restart', unit])) return 'restarted';
  if (process.platform === 'darwin' && typeof process.getuid === 'function') for (const label of ['com.turbokast.botwarren', 'com.botwarren.ship']) if (await run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`])) return 'restarted';
  if (process.platform === 'win32') {
    await run('schtasks.exe', ['/End', '/TN', 'Botwarren Ship Agent']);
    if (await run('schtasks.exe', ['/Run', '/TN', 'Botwarren Ship Agent'])) return 'restarted';
  }
  // no service installed: run the agent next to this CLI, detached (a second copy cannot start: the ops port is taken)
  const agent = [join(import.meta.dirname, 'agent.mjs'), join(import.meta.dirname, 'main.ts')].find(existsSync);
  if (!agent) return 'manual';
  try {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', agent], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, BOTWARREN_SHIP_CONFIG: configFile } });
    child.on('error', () => undefined);
    child.unref();
    return 'started';
  } catch { return 'manual'; }
})();

const defaultAgentUp = async (port: number): Promise<boolean> => {
  for (let i = 0; i < 20; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
};

/** The user-only secret file: parent folder 0700, file 0600 (Windows: ACL), written only after the lock-down. */
export async function writeSecretFile(path: string, secret: string, restrict: (p: string) => Promise<void>): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, '', { mode: 0o600 });
  await restrict(path);
  writeFileSync(path, secret, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* not supported on this file system */ }
}

export async function runPair(argv: string[], deps: PairDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stdout.write(s); });
  const err = deps.err ?? ((s: string) => { process.stderr.write(s); });
  const host = deps.host ?? currentHost();
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const f = deps.fetchImpl ?? fetch;
  const flags = parsePairFlags(argv);
  if (typeof flags === 'string') { err(`${flags}\nusage: botwarren pair [--no-open] [--no-start] [--repo <folder>]... [--name "<project name>"] [--url <site>]\n`); return 2; }

  // an existing config tells us the ship's site and keeps the owner's choices (projects, delay, ports) when re-pairing
  const cfgFile = env.BOTWARREN_SHIP_CONFIG ?? configPath(host);
  let existing: Record<string, unknown> | null = null;
  if (existsSync(cfgFile)) {
    try { existing = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>; }
    catch { err(`The config file ${cfgFile} is not valid JSON, so it was left alone. Fix or delete it, then run \`botwarren pair\` again.\n`); return 1; }
  }
  const site = siteOrigin(flags.site, env, typeof existing?.replicaUrl === 'string' ? existing.replicaUrl : null);
  if (!site) { err('The site address must be https (http is only allowed for localhost).\n'); return 2; }

  // projects: first run needs at least one folder; decide BEFORE asking the person to approve anything
  let repos = flags.repos.map((r) => resolve(deps.cwd ?? process.cwd(), r));
  const projectsKnown = Array.isArray(existing?.projects) && (existing!.projects as unknown[]).length > 0;
  let usedCwd = false;
  if (!projectsKnown && repos.length === 0) {
    const guess = (deps.findRepo ?? defaultFindRepo)(deps.cwd ?? process.cwd());
    if (guess) { repos = [guess]; usedCwd = true; }
    else if (deps.interactive ?? (process.stdin.isTTY === true)) {
      const ask = deps.prompt ?? (async (q: string) => { const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } });
      const answer = (await ask('Folder of the git checkout you want on your ship (for example ~/code/my-game): ')).trim();
      if (answer) repos = [resolve(deps.cwd ?? process.cwd(), answer.replace(/^~(?=$|[\\/])/, host.home))];
    }
    if (repos.length === 0) { err('Tell Botwarren which project folder to watch: run `botwarren pair --repo <folder>` (a git checkout). Only its name and size are ever used.\n'); return 2; }
  }
  for (const r of repos) if (!existsSync(r) || !statSync(r).isDirectory()) { err(`Folder not found: ${r}\n`); return 2; }

  // ---- 1. start
  let start: z.infer<typeof StartResponse>;
  try {
    const res = await f(`${site}/api/pair/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ os: osName(host), agent: VERSION }), redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
    if (res.status === 429) { err('Too many pairing attempts from here. Wait a few minutes and run `botwarren pair` again.\n'); return 1; }
    if (!res.ok) { err(`Could not start pairing (HTTP ${res.status}). Please try again in a little while.\n`); return 1; }
    start = StartResponse.parse(await res.json());
  } catch (e) {
    err(e instanceof z.ZodError ? 'The server answered in a format this version does not understand. Update the Botwarren ship agent and try again.\n' : `Could not reach ${site}. Check your internet connection and try again.\n`);
    return 1;
  }

  // ---- 2. show the code and open the page
  const page = validateLoginUrl(start.verification_uri, site);
  const complete = start.verification_uri_complete ? validateLoginUrl(start.verification_uri_complete, site) : null;
  if (!page) { err('The server sent a pairing page that does not look safe (not on botwarren.com), so it was not used.\n'); return 1; }
  if (existing) out('This computer already has a ship config. Pairing again gives the ship a NEW secret: the old one stops working.\n\n');
  out(`Your pairing code is  ${start.user_code}\n\n  1. Open ${page}  (log in if asked)\n  2. Check the code matches, then press Approve.\n\nOnly approve if you just ran this command. The code works once and expires in ${Math.round(start.expires_in / 60)} minutes.\n`);
  if (!flags.noOpen && complete) {
    const opened = await (deps.opener ?? systemOpener)(complete).catch(() => false);
    out(opened ? '\nOpening your browser for you...\n' : '\nCould not open a browser from here: open the page above on any device.\n');
  }
  out('\nWaiting for you to approve...\n');

  // ---- 3. poll
  const deadline = now() + start.expires_in * 1000;
  let interval = start.interval;
  let failures = 0;
  let paired: z.infer<typeof PairedResponse> | null = null;
  while (now() < deadline && !paired) {
    await sleep(interval * 1000);
    let res: Response;
    try {
      res = await f(`${site}/api/pair/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: start.device_code }), redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
    } catch { failures++; interval = Math.min(30, start.interval + failures * 2); continue; } // a dropped connection must not lose the pairing
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 200) {
      const ok = PairedResponse.safeParse(body);
      if (!ok.success || !shipUrlOk(ok.data.base_url, ok.data.ship_id, site)) { err('The server sent an answer this version does not trust, so nothing was saved. Run `botwarren pair` again.\n'); return 1; }
      paired = ok.data; break;
    }
    const e = ErrorResponse.safeParse(body);
    const code = e.success ? e.data.error : `http_${res.status}`;
    if (code === 'authorization_pending') { failures = 0; continue; }
    if (code === 'slow_down' || res.status === 429) { interval = Math.min(60, e.success && e.data.interval ? e.data.interval : interval + 5); continue; }
    if (code === 'access_denied') { err('The pairing was declined on the website. Nothing was changed.\n'); return 1; }
    if (code === 'expired_token') { err('The pairing code expired (or was already used). Run `botwarren pair` again for a new one.\n'); return 1; }
    if (code === 'ship_unavailable') { err('That ship is not available any more. Run `botwarren pair` again and pick another.\n'); return 1; }
    if (res.status >= 500) { failures++; interval = Math.min(30, start.interval + failures * 2); continue; }
    err(`Pairing failed (${code}). Run \`botwarren pair\` again.\n`); return 1;
  }
  if (!paired) { err('Nobody approved the code in time. Run `botwarren pair` again for a new one.\n'); return 1; }

  // ---- 4. save the secret, write the config, start publishing
  const secretFile = typeof existing?.secretFile === 'string' && existing.secretFile ? existing.secretFile : defaultSecretFile(host);
  try { await writeSecretFile(secretFile, paired.secret, deps.restrictFile ?? defaultRestrict); }
  catch (e) { err(`Could not save the ship secret to ${secretFile}: ${(e as Error).message}\nThis pairing is used up; run \`botwarren pair\` again once that is fixed.\n`); return 1; }
  const projects = projectsKnown ? existing!.projects : [{ id: paired.ship_id, publicName: flags.name ?? defaultPublicName(paired.ship_id), repoPaths: repos }];
  const raw: Record<string, unknown> = { ...(existing ?? { opsPort: 4411, demo: false }), shipId: paired.ship_id, replicaUrl: paired.base_url, secretFile, delaySeconds: existing?.delaySeconds ?? 90, onboardingUntil: onboardingUntilIso(now()), projects };
  try { resolveConfig(raw, host); } catch (e) { err(`The new configuration was not valid, so it was not saved: ${(e as Error).message}\n`); return 1; }
  mkdirSync(dirname(cfgFile), { recursive: true, mode: 0o700 });
  writeFileSync(cfgFile, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

  const shipName = paired.ship_name ?? paired.ship_id;
  out(`\nConnected: this computer is now linked to ${shipName}.\n`);
  if (usedCwd) out('Watching the project folder you ran this in. Only its name and size are used; change it in your config file any time.\n');
  if (flags.noStart) { out('The agent was not started (--no-start). Start it, or restart its service, to begin publishing.\n'); return 0; }
  const how = await (deps.startAgent ?? defaultStartAgent)(cfgFile).catch((): 'manual' => 'manual');
  if (how === 'manual') { out('Could not start the agent automatically. Start the "Botwarren Ship Agent" service, or run the agent from the install folder.\n'); return 0; }
  const up = await (deps.agentUp ?? defaultAgentUp)(typeof raw.opsPort === 'number' ? raw.opsPort : 4411);
  out(up ? `The agent is running${how === 'restarted' ? ' (restarted with your new ship)' : ''}.\n` : 'The agent was started but has not answered yet; give it a few seconds.\n');
  out(`\nOpen ${paired.base_url} to watch. Start a Claude Code or Codex session in your project: your first crew member appears in about 30 seconds (new ships publish with a 30 s delay for the first 15 minutes, then ${typeof raw.delaySeconds === 'number' ? raw.delaySeconds : 90} s).\nNothing from your prompts, code or files leaves this computer: only status codes do.\n`);
  return 0;
}
