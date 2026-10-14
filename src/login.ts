/**
 * `botwarren login`: asks the ship's own server for a one-time sign-in link (authenticated with the ship secret)
 * and opens it in the browser, so the ship owner can manage the ship on botwarren.com (e.g. mark it private).
 * The one-time link may be printed; the ship secret never is.
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { readShipSecret } from './secret.ts';
import type { ShipConfig } from './config.ts';

export type Opener = (url: string) => Promise<boolean>;

export interface LoginDeps {
  fetchImpl?: typeof fetch;
  opener?: Opener;
  readSecret?: (path: string) => string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  timeoutMs?: number;
}

const MAX_LINK_RESPONSE = 8_192;
const LinkResponse = z.object({ url: z.string().min(1).max(2048), expiresInSeconds: z.number().positive().max(86_400).optional() });
/** Conservative URL alphabet: nothing a shell or `cmd.exe` would treat specially (& ^ % | < > " ' ` space, control chars). */
const SAFE_URL = /^[A-Za-z0-9\-._~:/?#=@+,]+$/; // no `!` (cmd.exe delayed expansion) and no `;` (statement separator in shells): a one-time link never needs them

/** Reads a response body as text, throwing once it exceeds `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { void reader.cancel().catch(() => undefined); throw new Error('too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The ship's server origin, derived from the configured replica URL (base URL or .../internal/publish). */
export function shipOrigin(replicaUrl: string): string { return new URL(replicaUrl).origin; }

/** Returns the normalised URL if it is safe to hand to the OS opener, else null. */
export function validateLoginUrl(raw: string, serverOrigin: string): string | null {
  if (!SAFE_URL.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const onSite = u.protocol === 'https:' && (host === 'botwarren.com' || host.endsWith('.botwarren.com'));
  // local testing: exactly the configured server origin (config only allows http for localhost)
  const isServer = u.origin === serverOrigin && (u.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(host));
  return onSite || isServer ? u.href : null;
}

/** Default browser opener: argument arrays, never a shell string. Resolves false if it could not be launched. */
export const systemOpener: Opener = (url) => new Promise((resolve) => {
  let cmd: string; let args: string[]; const opts: { stdio: 'ignore'; detached: boolean; windowsVerbatimArguments?: boolean } = { stdio: 'ignore', detached: true };
  if (process.platform === 'win32') {
    // url is validated against SAFE_URL, so quoting it inside cmd's command string is safe
    cmd = 'cmd'; args = ['/d', '/s', '/c', `start "" "${url}"`]; opts.windowsVerbatimArguments = true;
  } else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  let done = false;
  const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
  const timer = setTimeout(() => finish(true), 4000); // launcher still running: assume it worked
  try {
    const child = spawn(cmd, args, opts);
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    child.unref();
  } catch { finish(false); }
});

/** Runs the login flow. Exit code 0 on success (link obtained), 1 otherwise. */
export async function runLogin(cfg: Pick<ShipConfig, 'replicaUrl' | 'secretFile'>, flags: string[], deps: LoginDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stdout.write(s); });
  const err = deps.err ?? ((s: string) => { process.stderr.write(s); });
  let noOpen = false;
  for (const f of flags) {
    if (f === '--no-open') noOpen = true;
    else { err(`unknown option ${f}\nusage: botwarren login [--no-open]\n`); return 1; }
  }

  let secret: string;
  try { secret = (deps.readSecret ?? readShipSecret)(cfg.secretFile); }
  catch (e) { err(`Could not read your ship secret: ${(e as Error).message}\nRe-run the installer, or check that the secret file exists.\n`); return 1; }

  const origin = shipOrigin(cfg.replicaUrl);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${origin}/internal/login-link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: '{}', redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch (e) {
    const timedOut = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
    err(timedOut ? `Timed out after 10 seconds waiting for ${origin}. Check your internet connection and try again.\n`
      : `Could not reach ${origin}. Check your internet connection and try again.\n`);
    return 1;
  }

  if (res.status === 401) { err('Your ship secret was not accepted (HTTP 401). The secret file on this computer may be out of date - ask the Botwarren owner for help.\n'); return 1; }
  if (res.status === 429) { err('Too many sign-in links requested. Wait a few minutes (limit is about 5 per 10 minutes) and try again.\n'); return 1; }
  if (!res.ok) { err(`Could not get a sign-in link (HTTP ${res.status}). Please try again later.\n`); return 1; }

  let body: z.infer<typeof LinkResponse>;
  try { body = LinkResponse.parse(JSON.parse(await readCapped(res, MAX_LINK_RESPONSE))); }
  catch { err('The server sent a sign-in link in a format this version does not understand. Update the Botwarren ship agent and try again.\n'); return 1; }

  const url = validateLoginUrl(body.url, origin);
  if (!url) { err('The server returned a sign-in link that does not look safe (not https on botwarren.com), so it was not opened.\n'); return 1; }

  const minutes = Math.max(1, Math.round((body.expiresInSeconds ?? 600) / 60));
  const note = `This link works once and expires in ${minutes} minute${minutes === 1 ? '' : 's'}. Do not share it.\n`;
  if (noOpen) { out(`Your Botwarren sign-in link:\n\n  ${url}\n\n${note}`); return 0; }

  const opened = await (deps.opener ?? systemOpener)(url).catch(() => false);
  if (opened) out(`Opening your browser to sign in as the owner of your ship.\nIf nothing opens, paste this link into your browser:\n\n  ${url}\n\n${note}`);
  else out(`Could not open a browser automatically. Paste this link into your browser:\n\n  ${url}\n\n${note}`);
  return 0;
}
