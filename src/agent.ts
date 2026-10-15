/**
 * Ship agent wiring: PrivateService (ingest + local ops room) + Replicator (public.db only) +
 * log session adapter + code-size measurement. One process, one data dir, loopback only.
 *
 * Zero-touch (0.6): projects are noticed from the coding sessions themselves (discovery.ts) and shown only when the owner switches
 * them on at botwarren.com; the owner's other settings (publish delay, tools off, real names, pause) come back in the publish
 * response and are validated and clamped here; the agent tells the owner's console what it is (cloudlink.ts). A revoked secret is
 * noticed and forgotten (onRevoked).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Server } from 'node:http';
import { PrivateService } from './local/service.ts';
import { Replicator } from './local/replicator.ts';
import { measure, metricsEvent } from './readers/codesize.ts';
import { parseAdaptersOff, parseDelay, parseProjectChoices, type AgentAdapterId, type CanonicalEventInput, type ShipManifest } from './vendor/core/contract.ts';
import { defaultPublicName, publishUrl, type ShipConfig } from './config.ts';
import { dataPaths } from './paths.ts';
import { ProjectAttributor, gitRemote } from './attribution.ts';
import { safeErrorCode } from './adapters/api.ts';
import { AdapterHost } from './adapters/host.ts';
import { buildAdapters, reportAdapters } from './adapters/registry.ts';
import { makeDetectEnv } from './adapters/config.ts';
import { currentHost } from './paths.ts';
import { heartbeat, sha } from './events.ts';
import { readShipSecret } from './secret.ts';
import { buildManifest, wantsRealNames, type NamedProject } from './names.ts';
import { applyCloudLook } from './cloud.ts';
import { applyOnboardingDelay } from './onboarding.ts';
import { VERSION } from './version.ts';
import { startUpdateService } from './update/service.ts';
import { ProjectDiscovery, discoveryFile } from './discovery.ts';
import { startComponentService, type ComponentService } from './component/service.ts';
import { agentReportUrl, applyAdapterOverrides, buildAgentReport, companionUrl, postAgentReport, reportSignature, shouldWipe } from './cloudlink.ts';

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

export interface RunningAgent { svc: PrivateService; server: Server; replicator: Replicator; adapters: AdapterHost; discovery: ProjectDiscovery; stop: () => Promise<void> }

export interface AgentOptions {
  log?: (m: string) => void;
  replicate?: boolean;
  fetchImpl?: typeof fetch;
  opsHtmlPath?: string;
  /** called when a staged update should start (idle); main.ts drains and exits 75 */
  onRestartForUpdate?: () => void;
  /** the website revoked this computer's secret (sustained 401s): the caller wipes the connection and waits to be connected again */
  onRevoked?: () => void;
  /** test hooks */
  revokeAfterCount?: number;
  revokeAfterMs?: number;
  reportEveryMs?: number;
  housekeepingMs?: number;
}

export async function startAgent(cfg: ShipConfig, opts: AgentOptions = {}): Promise<RunningAgent> {
  const paths = dataPaths(cfg.dataDir);
  const log = opts.log ?? makeLogger(paths.logFile);
  const secret = readShipSecret(cfg.secretFile);
  const instance = sha(hostname(), cfg.shipId).slice(0, 12);
  const host = currentHost();

  // ---- projects. The hand-configured ones (older installs, `--repo`) plus the ones the agent NOTICED that the owner chose to show on
  // the website. `live` is shared BY REFERENCE with the attribution and the adapters, so a change from the website applies on the next poll.
  const discovery = new ProjectDiscovery({ file: discoveryFile(cfg.dataDir), home: host.home, gitRemote, sendNames: cfg.discoveryNames });
  const live: { id: string; repoPaths: string[] }[] = [];
  let showRealNames = false;
  const shipUpper = cfg.shipId.toUpperCase();
  const genericName = (n: number): string => (n <= 1 ? defaultPublicName(cfg.shipId) : `${shipUpper.slice(0, 26)} Project ${n}`);
  const namedProjects = (): NamedProject[] => {
    const legacy: NamedProject[] = cfg.projects.map((p) => ({ ...p }));
    const found: NamedProject[] = discovery.shown().map((d, i) => ({ id: d.id, publicName: genericName(legacy.length + i + 1), realName: d.publicName, repoPaths: [d.root] }));
    return [...legacy, ...found];
  };
  /** the public manifest for the current projects; a ship with none yet publishes one placeholder building (nothing is ever published for it) */
  const manifestNow = (): { ids: string[]; manifest: ShipManifest } => {
    const named = namedProjects();
    const base = buildManifest({ shipId: cfg.shipId, projects: named.length ? named : [{ id: cfg.shipId, publicName: defaultPublicName(cfg.shipId), realName: null, repoPaths: [] }] }, showRealNames);
    return { ids: named.map((p) => p.id), manifest: base as ShipManifest };
  };
  live.push(...namedProjects().map((p) => ({ id: p.id, repoPaths: p.repoPaths })));
  const initial = manifestNow();

  let statusExtra: () => Record<string, unknown> = () => ({});
  const opsHtmlPath = opts.opsHtmlPath ?? join(import.meta.dirname, 'ops.html');
  const svc = new PrivateService({
    privateDbPath: paths.privateDb, publicDbPath: paths.publicDb,
    ingestToken: ensureSecretFile(paths.ingestToken), opsToken: ensureSecretFile(paths.opsToken),
    delaySeconds: cfg.delaySeconds, demoMode: cfg.demo, publicProjects: initial.ids,
    // public ship manifest: SAFE names until the server says the owner opted in to real names (validated against core's DisplayText)
    shipManifest: initial.manifest,
    statusExtra: () => statusExtra(),
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

  const attributor = new ProjectAttributor(live);
  let attributionEpoch = 0;
  const entries = buildAdapters(cfg, host);
  const savedAdapterSettings = new Map<AgentAdapterId, boolean | 'auto'>();
  let lookRejected: string | null = null;
  let projectsRejected = false;
  /** the optional Botwarren Companion component (component/): driven only by the website's install/remove directive, gated by install.ts */
  let components: ComponentService | null = null;

  /** the owner's project choices changed (or real names switched): rebuild the allowlist and the public manifest together */
  const rebuild = (): void => {
    const next = manifestNow();
    live.splice(0, live.length, ...namedProjects().map((p) => ({ id: p.id, repoPaths: p.repoPaths })));
    attributor.reset();
    attributionEpoch++;
    svc.setProjects(next.ids, next.manifest);
  };

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

      // which noticed projects the ship shows (only keys this agent discovered itself are honoured) and what they are called
      let rebuildNeeded = false;
      const choices = parseProjectChoices(settings?.projects);
      if (choices) { if (discovery.applyChoices(choices)) { rebuildNeeded = true; log('shown projects updated from the website'); } projectsRejected = false; }
      else if (settings?.projects !== undefined && !projectsRejected) { projectsRejected = true; log('ignored project choices from the website (not valid)'); }
      const next = wantsRealNames(settings);
      if (next !== showRealNames) { showRealNames = next; rebuildNeeded = true; log(`public project names: ${next ? 'real names ON (owner setting)' : 'safe generic names'}`); }
      if (rebuildNeeded) { rebuild(); changed = true; }

      // publish delay (30..120 s, clamped); applied once per change, so a later local edit stays until the website changes it again
      const delay = parseDelay(settings?.delaySeconds);
      if (delay !== null && String(delay) !== svc.store.getSetting('cloud_delay_applied')) {
        svc.setDelay(delay, 'cloud'); svc.store.setSetting('cloud_delay_applied', String(delay)); log(`publish delay set to ${delay}s from the website`); changed = true;
      }
      // tools switched off on the website (they can only be turned off, or back to the configured setting)
      const off = parseAdaptersOff(settings?.adapters);
      if (off && applyAdapterOverrides(entries, off, savedAdapterSettings)) { log(`tools switched off from the website: ${off.length ? off.join(', ') : 'none'}`); changed = true; }
      components?.onSettings(settings as { companion?: unknown } | null);
      if (changed) setTimeout(() => void replicator.tick(), 0).unref();
    },
  });
  if (opts.replicate !== false) replicator.start();

  const adapters = new AdapterHost({
    adapters: entries, instance, host, log,
    projects: live, attributionEpoch: () => attributionEpoch,
    // a session in a folder that is no project yet is NOTICED (name and key go to the owner's console, the path stays here); it is not published
    attribute: async (cwd, nowMs) => {
      const r = await attributor.attribute(cwd, nowMs);
      if (r.projectId === null && cwd) void discovery.note(cwd).catch(() => undefined);
      return r.projectId;
    },
    detect: (adapter, settings) => adapter.detect(makeDetectEnv(host, settings, live)),
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
      for (const p of live) {
        const repo = p.repoPaths[0];
        const m = repo ? await measureRepo(repo) : null;
        if (m) ingest([metricsEvent(p.id as never, m, instance, new Date())]);
        else log(`code size: ${p.id} not measurable (no git history yet?)`);
      }
    } catch (e) { log(`code size failed: ${(e as Error).message}`); } finally { sizing = false; }
  };

  // ---- the owner-only report to the website (what this computer is, which tools it sees, which projects it noticed)
  const reportUrl = agentReportUrl(publishUrl(cfg.replicaUrl));
  let reportSig = '';
  let reportedAt = 0;
  let reportInFlight = false;
  let reportBlockedUntil = 0;
  const reportEveryMs = opts.reportEveryMs ?? 10 * 60_000;
  const maybeReport = async (force = false): Promise<void> => {
    if (reportInFlight || Date.now() < reportBlockedUntil || replicator.lastOkAt === null) return; // not before the website has answered a publish
    const quick = buildAgentReport({ host, statuses: adapters.statuses(), detections: [], projects: discovery.report() });
    const sig = reportSignature(quick);
    if (!force && sig === reportSig && Date.now() - reportedAt < reportEveryMs) return;
    reportInFlight = true;
    try {
      const detections = await reportAdapters(entries, host, live).catch(() => []);
      const report = buildAgentReport({ host, statuses: adapters.statuses(), detections, projects: discovery.report() });
      const r = await postAgentReport({ url: reportUrl, secret, version: VERSION, lane: laneId(svc), report, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
      if (r === 'old_server') reportBlockedUntil = Date.now() + 3_600_000; // a server without the route: ask again in an hour
      else if (r === 'ok') { reportSig = reportSignature(report); reportedAt = Date.now(); discovery.flush(); }
    } catch (e) { log(`owner report failed (${safeErrorCode(e)})`); } finally { reportInFlight = false; }
  };

  // ---- has the website revoked this computer? (sustained 401s; see cloudlink.shouldWipe)
  let revokedFired = false;
  const watchRevoked = (): void => {
    if (revokedFired || !shouldWipe(replicator.unauthorized, Date.now(), opts.revokeAfterCount, opts.revokeAfterMs)) return;
    revokedFired = true;
    log('the website no longer accepts this computer (disconnected or replaced): publishing stopped');
    opts.onRevoked?.();
  };

  statusExtra = () => ({
    shipId: cfg.shipId, site: new URL(cfg.replicaUrl).origin, lastOkAt: replicator.lastOkAt, lastError: replicator.lastError,
    unauthorized: replicator.unauthorized.count, projectsNoticed: discovery.list().length, projectsShown: discovery.shown().length + cfg.projects.length,
    reportedAt: reportedAt ? new Date(reportedAt).toISOString() : null, agentVersion: VERSION,
    tools: adapters.statuses().map((s) => ({ id: s.id, state: s.state, code: s.code })),
  });

  ingest([heartbeat(instance, 'healthy', new Date())]);
  timers.push(
    setInterval(() => void scan(), 3000), setInterval(() => ingest([heartbeat(instance, 'healthy', new Date())]), 30_000), setInterval(() => void size(), 30 * 60_000),
    setInterval(() => { void maybeReport(); watchRevoked(); discovery.flush(); }, opts.housekeepingMs ?? 15_000),
  );
  for (const t of timers) t.unref();
  void scan();
  setTimeout(() => void size(), 10_000).unref();
  setTimeout(() => void maybeReport(true), Math.min(5_000, opts.housekeepingMs ?? 5_000)).unref();

  // silent updates (off unless launched by the launcher; see update/policy.ts for every opt-out)
  const updates = startUpdateService({
    env: process.env, config: cfg.updates, log, isIdle: () => Date.now() - lastActivityAt > 60_000,
    restart: () => (opts.onRestartForUpdate ?? (() => log('update staged; restart the agent to apply it')))(),
  });
  const root = process.env.BOTWARREN_HOME || join(cfg.dataDir, 'home');
  if (opts.replicate !== false) components = startComponentService({
    root, baseUrl: updates.policy.baseUrl, agentVersion: VERSION, cloudUrl: companionUrl(publishUrl(cfg.replicaUrl)), secret, log, env: process.env,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), allowDevKey: process.env.BOTWARREN_UPDATE_ALLOW_DEV_KEY === '1',
  });
  log(`ship agent started: ship=${cfg.shipId} projects=${live.map((p) => p.id).join(',') || 'none yet (noticed from your sessions)'} ops=127.0.0.1:${cfg.opsPort} delay=${svc.delaySeconds}s replica=${new URL(cfg.replicaUrl).origin} adapters=${adapters.statuses().length}`);

  return {
    svc, server, replicator, adapters, discovery,
    stop: async () => {
      for (const t of timers) clearInterval(t);
      updates.stop();
      components?.stop();
      await adapters.stop();
      discovery.flush();
      svc.stop(); replicator.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
