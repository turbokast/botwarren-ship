/**
 * Runs the website's companion directive on this computer: install (gated by install.ts), enrol the companion with the relay, keep its daemon
 * running, report the result, or remove it. One operation at a time, backoff on failure, and nothing happens unless the user consented
 * (a recorded directive) and this computer has not blocked components.
 *
 * What the agent sends the website: the companion's PUBLIC host key (so the website can sign a relay ticket for it), and the install result
 * (enum + version). What it never sends: anything the companion reads or any device information.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { entryPath, installCompanion, isLocallyBlocked, readConsent, readCurrent, recordConsent, removeCompanion, runCompanion, type InstallOptions } from './install.ts';
import { parseDirective, type Directive } from './directive.ts';
import { ensureShim, removeShim, type ShimEnv } from './shim.ts';

export interface ComponentServiceOptions {
  root: string;
  baseUrl: string;
  agentVersion: string;
  /** https://<ship>.botwarren.com/internal/companion (no trailing slash) */
  cloudUrl: string;
  secret: string;
  env?: Record<string, string | undefined>;
  log: (m: string) => void;
  fetchImpl?: typeof fetch;
  allowDevKey?: boolean;
  keys?: InstallOptions['keys'];
  now?: () => number;
  selftest?: InstallOptions['selftest'];
  /** tests: do not spawn a real daemon */
  startDaemon?: (entry: string) => { stop: (kill?: boolean) => void };
  /** tests: replace running the companion binary (init / enroll) */
  run?: (entry: string, args: string[], input?: string) => Promise<{ code: number | null; stdout: string }>;
  retryMs?: number;
  /** where the `botwarren-companion` shim goes (tests); default: the per-user bin directory of the installers */
  shim?: ShimEnv;
}

export interface ComponentService {
  /** feed every publish response's settings; cheap and safe to call often */
  onSettings(settings: { companion?: unknown } | null): void;
  /** resolves when the current operation (if any) has finished (tests) */
  idle(): Promise<void>;
  stop(): void;
}

async function post(f: typeof fetch, url: string, secret: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await f(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = (await res.text()).slice(0, 20_000);
  let json: unknown = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, json };
}

export function startComponentService(o: ComponentServiceOptions): ComponentService {
  const now = o.now ?? Date.now;
  const f = o.fetchImpl ?? fetch;
  const run = o.run ?? runCompanion;
  let busy: Promise<void> = Promise.resolve();
  let lastKey = '';
  let blockedUntil = 0;
  let daemon: { stop: (kill?: boolean) => void } | null = null;
  let stopped = false;

  const spawnDaemon = (entry: string): { stop: (kill?: boolean) => void } => {
    let child: ChildProcess | null = null; let off = false; let backoff = 2000;
    const go = (): void => {
      if (off) return;
      child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, 'daemon'], { stdio: 'ignore', windowsHide: true });
      const t0 = Date.now();
      child.on('exit', () => { child = null; if (off) return; backoff = Date.now() - t0 > 60_000 ? 2000 : Math.min(backoff * 2, 60_000); const t = setTimeout(go, backoff); t.unref(); });
      child.on('error', () => { /* exit follows */ });
    };
    go();
    return { stop: (kill = true) => { off = true; if (kill) try { child?.kill('SIGTERM'); } catch { /* gone */ } } };
  };

  const report = async (state: 'installed' | 'failed' | 'removed', version?: string, code?: string): Promise<void> => {
    try { await post(f, `${o.cloudUrl}/report`, o.secret, { state, ...(version ? { version } : {}), ...(code ? { code } : {}) }); } catch { /* retried with the next directive */ }
  };

  const ensureEnrolled = async (entry: string): Promise<boolean> => {
    const init = await run(entry, ['init', '--json']);
    let host: { hostSig?: string } = {};
    try { host = JSON.parse(init.stdout) as typeof host; } catch { return false; }
    if (!host.hostSig) return false;
    const t = await post(f, `${o.cloudUrl}/ticket`, o.secret, { hostSig: host.hostSig });
    if (t.status !== 200 || !t.json || typeof t.json !== 'object') return false;
    const enr = await run(entry, ['enroll'], JSON.stringify({ v: 1, relayUrl: (t.json as { relayUrl?: string }).relayUrl, ticket: (t.json as { ticket?: unknown }).ticket, acct: (t.json as { acct?: string }).acct }));
    return enr.code === 0;
  };

  const doInstall = async (d: Directive): Promise<void> => {
    if (!readConsent(o.root) || readConsent(o.root)!.consentAt !== d.consent) recordConsent(o.root, d.consent, now());
    o.log(`companion: your account asked for it (consent ${d.consent}); verifying the signed component before anything runs`);
    const r = await installCompanion({
      root: o.root, baseUrl: o.baseUrl, agentVersion: o.agentVersion, now, log: o.log, ...(o.env ? { env: o.env } : {}), ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.keys ? { keys: o.keys } : {}), ...(o.allowDevKey ? { allowDevKey: true } : {}), ...(o.selftest ? { selftest: o.selftest } : {}),
    });
    if (r.status === 'refused') { await report('failed', undefined, r.code === 'manifest_refused' ? 'manifest_refused' : r.code); blockedUntil = now() + (o.retryMs ?? 15 * 60_000); return; }
    const cur = readCurrent(o.root);
    if (!cur) return;
    const entry = entryPath(o.root, cur.version);
    // `botwarren-companion pair` should work in a new terminal: a launcher next to the `botwarren` command (shim.ts), never over a file we did not write
    const shim = ensureShim(o.shim ?? { env: o.env ?? process.env });
    if (shim === 'written') o.log('companion: added the `botwarren-companion` command next to `botwarren` (the same as `botwarren companion ...`)');
    if (!(await ensureEnrolled(entry))) { o.log('companion: installed, but it could not be enrolled with the relay yet; will retry'); await report('failed', cur.version, 'enroll_failed'); blockedUntil = now() + (o.retryMs ?? 15 * 60_000); }
    else await report('installed', cur.version);
    daemon?.stop();
    daemon = (o.startDaemon ?? spawnDaemon)(entry);
  };

  const doRemove = async (): Promise<void> => {
    daemon?.stop(false); // stop supervising (so it is not restarted) but let the companion's own uninstall shut it down cleanly
    daemon = null;
    await removeCompanion({ root: o.root, log: o.log, run: async (entry, args) => (await run(entry, args)).code === 0 });
    removeShim(o.shim ?? { env: o.env ?? process.env });
    await report('removed');
  };

  return {
    onSettings(settings): void {
      if (stopped || now() < blockedUntil) return;
      const d = parseDirective(settings?.companion, now());
      if (!d) {
        // silence is not an instruction: an installed companion keeps running, and a missing directive never removes anything
        return;
      }
      const cur = readCurrent(o.root);
      // already in the wanted state: only make sure the daemon runs
      if (d.want === 'install' && cur && !daemon && !isLocallyBlocked(o.root, o.env ?? process.env) && readConsent(o.root)) {
        const entry = entryPath(o.root, cur.version);
        daemon = (o.startDaemon ?? spawnDaemon)(entry);
      }
      const key = `${d.want}|${d.consent}|${cur?.version ?? '-'}`;
      if (key === lastKey) return;
      if (d.want === 'install' && cur && readConsent(o.root)?.consentAt === d.consent) { lastKey = key; return; }
      if (d.want === 'remove' && !cur && !readConsent(o.root)) { lastKey = key; void report('removed'); return; }
      lastKey = key;
      busy = busy.then(async () => { try { if (d.want === 'install') await doInstall(d); else await doRemove(); } catch (e) { o.log(`companion: ${d.want} failed (${(e as Error).name})`); lastKey = ''; blockedUntil = now() + (o.retryMs ?? 15 * 60_000); } });
    },
    idle: () => busy,
    stop(): void { stopped = true; daemon?.stop(); daemon = null; },
  };
}
