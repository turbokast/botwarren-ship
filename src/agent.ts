/**
 * Ship agent wiring: PrivateService (ingest + local ops room) + Replicator (public.db only) +
 * log session adapter + code-size measurement. One process, one data dir, loopback only.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Server } from 'node:http';
import { PrivateService } from './local/service.ts';
import { Replicator } from './local/replicator.ts';
import { measure, metricsEvent } from './readers/codesize.ts';
import type { CanonicalEventInput } from './vendor/core/contract.ts';
import { publishUrl, type ShipConfig } from './config.ts';
import { dataPaths } from './paths.ts';
import { ProjectAttributor } from './attribution.ts';
import { safeErrorCode } from './adapters/api.ts';
import { AdapterHost } from './adapters/host.ts';
import { buildAdapters } from './adapters/registry.ts';
import { makeDetectEnv } from './adapters/config.ts';
import { currentHost } from './paths.ts';
import { heartbeat, sha } from './events.ts';
import { readShipSecret } from './secret.ts';
import { buildManifest, wantsRealNames } from './names.ts';
import { applyCloudLook } from './cloud.ts';
import { applyOnboardingDelay } from './onboarding.ts';
import { VERSION } from './version.ts';
import { startUpdateService } from './update/service.ts';

/** A random id for THIS installation, kept in its private settings (it is not derived from anything about the computer). */
export function laneId(svc: { store: { getSetting(k: string): string | undefined; setSetting(k: string, v: string): void } }): string {
  const have = svc.store.getSetting('lane_id');
  if (have && /^[a-f0-9]{8,32}$/.test(have)) return have;
  const id = randomBytes(8).toString('hex');
  svc.store.setSetting('lane_id', id);
  return id;
}

/** Reads a secret file, or creates a random one (0600; Windows ACLs are set by the installer). Never logged. */
export function ensureSecretFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600 });
  return readFileSync(path, 'utf8').trim();
}

export { readShipSecret } from './secret.ts';

export function makeLogger(file: string): (msg: string) => void {
  mkdirSync(dirname(file), { recursive: true });
  try { if (existsSync(file) && statSync(file).size > 5_000_000) renameSync(file, `${file}.1`); } catch { /* ignore */ }
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try { appendFileSync(file, line); } catch { /* ignore */ }
    process.stdout.write(line);
  };
}

/** origin/main if present, else HEAD (a fresh repo without a remote still gets a size). */
export async function measureRepo(repo: string): Promise<{ codeLines: number; files: number } | null> {
  return (await measure(repo, 'origin/main')) ?? (await measure(repo, 'HEAD'));
}

export interface RunningAgent { svc: PrivateService; server: Server; replicator: Replicator; adapters: AdapterHost; stop: () => Promise<void> }

export async function startAgent(cfg: ShipConfig, opts: { log?: (m: string) => void; replicate?: boolean; fetchImpl?: typeof fetch; opsHtmlPath?: string; /** called when a staged update should start (idle); main.ts drains and exits 75 */ onRestartForUpdate?: () => void } = {}): Promise<RunningAgent> {
  const paths = dataPaths(cfg.dataDir);
  const log = opts.log ?? makeLogger(paths.logFile);
  const secret = readShipSecret(cfg.secretFile);
  const instance = sha(hostname(), cfg.shipId).slice(0, 12);

  const opsHtmlPath = opts.opsHtmlPath ?? join(import.meta.dirname, 'ops.html');
  const svc = new PrivateService({
    privateDbPath: paths.privateDb, publicDbPath: paths.publicDb,
    ingestToken: ensureSecretFile(paths.ingestToken), opsToken: ensureSecretFile(paths.opsToken),
    delaySeconds: cfg.delaySeconds, demoMode: cfg.demo, publicProjects: cfg.projects.map((p) => p.id),
    // public ship manifest: SAFE names until the server says the owner opted in to real names (validated against core's DisplayText)
    shipManifest: buildManifest(cfg, false),
    opsHtml: () => (opsHtmlPath && existsSync(opsHtmlPath) ? readFileSync(opsHtmlPath, 'utf8') : '<h1>Botwarren ops</h1>'),
  });

  // Loopback only. Bind first: a second instance fails here before any timers/replication start.
  const server = svc.server();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.opsPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  }).catch((e: NodeJS.ErrnoException) => {
    svc.stop();
    throw new Error(e.code === 'EADDRINUSE' ? `port ${cfg.opsPort} is in use - is the ship agent already running?` : e.message);
  });

  svc.start();
  // first minutes after pairing: the 30 s minimum delay, so the first crew member shows up fast; then the configured delay again
  const timers: NodeJS.Timeout[] = [];
  const onboarding = () => {
    const left = applyOnboardingDelay(svc, cfg, Date.now());
    if (left !== null) { const t = setTimeout(onboarding, Math.min(left + 1000, 2_147_000_000)); t.unref(); timers.push(t); log(`new ship: publishing with a ${svc.delaySeconds}s delay for about ${Math.ceil(left / 60_000)} more minute(s), then ${cfg.delaySeconds}s`); }
  };
  onboarding();
  let showRealNames = false;
  let lookRejected: string | null = null;
  const replicator: Replicator = new Replicator({
    url: publishUrl(cfg.replicaUrl), secret, publicDbPath: paths.publicDb, store: svc.store, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    // this installation's own id: when it changes (a new computer, a reinstall) the server starts a new sequence lane instead of skipping its events
    headers: { 'x-botwarren-agent': VERSION, 'x-botwarren-lane': laneId(svc) },
    // "Pause publishing" on the website: send the heartbeat but no new events while it is on
    holdEvents: () => svc.remotePaused,
    // owner-controlled: real names only while the server says so; silence or any other answer = safe names, republished at once
    onSettings: (settings) => {
      let changed = false;
      const paused = settings?.paused === true;
      if (paused !== svc.remotePaused) { svc.setRemotePause(paused); log(`publishing ${paused ? 'PAUSED from the website (heartbeat continues)' : 'resumed from the website'}`); changed = true; }
      const look = applyCloudLook(svc, settings);
      if (look === 'applied' || look === 'reset') { log(`ship look ${look === 'reset' ? 'reset' : 'updated'} from the website`); changed = true; lookRejected = null; }
      else if (look === 'rejected' && lookRejected !== JSON.stringify(settings?.look)) { lookRejected = JSON.stringify(settings?.look); log('ignored a ship look from the website (not valid for this ship)'); }
      const next = wantsRealNames(settings);
      if (next !== showRealNames) {
        showRealNames = next;
        svc.setShipManifest(buildManifest(cfg, next));
        log(`public project names: ${next ? 'real names ON (owner setting)' : 'safe generic names'}`);
        changed = true;
      }
      if (changed) setTimeout(() => void replicator.tick(), 0).unref();
    },
  });
  if (opts.replicate !== false) replicator.start();

  const attributor = new ProjectAttributor(cfg.projects.map((p) => ({ id: p.id, repoPaths: p.repoPaths })));
  const host = currentHost();
  const adapters = new AdapterHost({
    adapters: buildAdapters(cfg, host), instance, host, log,
    projects: cfg.projects.map((p) => ({ id: p.id, repoPaths: p.repoPaths })),
    attribute: async (cwd, nowMs) => (await attributor.attribute(cwd, nowMs)).projectId,
    detect: (adapter, settings) => adapter.detect(makeDetectEnv(host, settings, cfg.projects.map((p) => ({ id: p.id, repoPaths: p.repoPaths })))),
  });
  let lastActivityAt = 0;
  const ingest = (events: CanonicalEventInput[]) => { if (events.length) { svc.ingest(events); if (events.some((e) => e.type !== 'collector.heartbeat')) lastActivityAt = Date.now(); } };

  let scanning = false;
  const scan = async () => {
    if (scanning) return; scanning = true;
    try {
      ingest(await adapters.tick(new Date())); // adapters run in a fixed order: Claude before Codex (pairing needs fresh master mtimes)
    } catch (e) { log(`session scan failed (${safeErrorCode(e)})`); } finally { scanning = false; }
  };
  // an adapter hint (e.g. a Ninox event) polls sooner, at most once a second
  let lastWake = 0;
  adapters.onWake = () => {
    if (Date.now() - lastWake < 1000) return; lastWake = Date.now();
    const only = new Set(adapters.takePollRequests());
    if (only.size === 0) return;
    void (async () => { try { ingest(await adapters.tick(new Date(), only)); } catch (e) { log(`adapter wake failed (${safeErrorCode(e)})`); } })();
  };
  await adapters.start();
  let sizing = false;
  const size = async () => {
    if (sizing) return; sizing = true;
    try {
      for (const p of cfg.projects) {
        const repo = p.repoPaths[0];
        const m = repo ? await measureRepo(repo) : null;
        if (m) ingest([metricsEvent(p.id as never, m, instance, new Date())]);
        else log(`code size: ${p.id} not measurable (no git history yet?)`);
      }
    } catch (e) { log(`code size failed: ${(e as Error).message}`); } finally { sizing = false; }
  };
  ingest([heartbeat(instance, 'healthy', new Date())]);
  timers.push(setInterval(() => void scan(), 3000), setInterval(() => ingest([heartbeat(instance, 'healthy', new Date())]), 30_000), setInterval(() => void size(), 30 * 60_000));
  for (const t of timers) t.unref();
  void scan();
  setTimeout(() => void size(), 10_000).unref();

  // silent updates (off unless launched by the launcher; see update/policy.ts for every opt-out)
  const updates = startUpdateService({
    env: process.env, config: cfg.updates, log, isIdle: () => Date.now() - lastActivityAt > 60_000,
    restart: () => (opts.onRestartForUpdate ?? (() => log('update staged; restart the agent to apply it')))(),
  });
  log(`ship agent started: ship=${cfg.shipId} projects=${cfg.projects.map((p) => p.id).join(',')} ops=127.0.0.1:${cfg.opsPort} delay=${svc.delaySeconds}s replica=${new URL(cfg.replicaUrl).origin} adapters=${adapters.statuses().length}`);

  return {
    svc, server, replicator, adapters,
    stop: async () => {
      for (const t of timers) clearInterval(t);
      updates.stop();
      await adapters.stop();
      svc.stop(); replicator.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
