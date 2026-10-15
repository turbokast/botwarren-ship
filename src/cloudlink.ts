/**
 * The agent's side of the owner-only link to the website (zero-touch onboarding):
 *  - `buildAgentReport`: what the agent tells its owner's console (computer kind, agent version, which tools it can see, which projects
 *    it noticed: opaque key + display name). Validated against the shared strict schema before it is sent; no path can be in it.
 *  - `postAgentReport`: POST <ship>/internal/agent with the ship secret. Redirects are refused (the secret must never follow one);
 *    an older server that has no such route (404) is remembered and not asked again for an hour.
 *  - `shouldWipe`: has the website revoked this computer? The publish endpoint answers 401 forever once the secret is revoked or replaced;
 *    only SUSTAINED refusals (several, over minutes) count, so a hiccup or a re-pair race never makes the agent forget its secret.
 *  - `applyAdapterOverrides`: the owner's "tools off" list from the website, applied to the live adapter settings (and undone when the
 *    owner switches a tool back on). The cloud can only turn adapters OFF or return them to their configured setting: it can never
 *    turn one on that the local config disabled.
 */
import { AgentReport, type AgentAdapterId } from './vendor/core/contract.ts';
import type { AdapterEntry, AdapterReport } from './adapters/registry.ts';
import type { AdapterStatus } from './adapters/host.ts';
import type { Host } from './paths.ts';
import { archName } from './connect.ts';
import { osName } from './pair.ts';

export function buildAgentReport(o: { host: Host; arch?: string; statuses: AdapterStatus[]; detections: Pick<AdapterReport, 'id' | 'detection' | 'platformSupported'>[]; projects: { id: string; name: string }[] }): AgentReport {
  const found = new Map(o.detections.map((d) => [d.id, d.platformSupported && d.detection.found]));
  return AgentReport.parse({
    v: 1, os: osName(o.host), arch: archName(o.arch ?? process.arch),
    adapters: o.statuses.map((s) => ({ id: s.id, state: s.state, found: found.get(s.id) ?? false })),
    projects: o.projects,
  });
}

/** stable fingerprint of a report (when it changes, tell the website soon) */
export const reportSignature = (r: AgentReport): string => JSON.stringify([r.os, r.arch, r.adapters, r.projects]);

export type ReportResult = 'ok' | 'old_server' | 'error';
export async function postAgentReport(o: { url: string; secret: string; version: string; lane: string; report: AgentReport; fetchImpl?: typeof fetch }): Promise<ReportResult> {
  try {
    const res = await (o.fetchImpl ?? fetch)(o.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${o.secret}`, 'content-type': 'application/json', 'x-botwarren-agent': o.version, 'x-botwarren-lane': o.lane },
      body: JSON.stringify(o.report),
    });
    if (res.status === 404) return 'old_server';
    return res.ok ? 'ok' : 'error';
  } catch { return 'error'; }
}

/** `<ship origin>/internal/agent` from the configured replica URL (base URL or the full publish URL) */
export function agentReportUrl(publishUrl: string): string {
  const u = new URL(publishUrl);
  u.pathname = '/internal/agent'; u.search = ''; u.hash = '';
  return u.toString();
}

/** `<ship origin>/internal/companion` from the configured replica URL */
export function companionUrl(publishUrl: string): string {
  const u = new URL(publishUrl);
  u.pathname = '/internal/companion'; u.search = ''; u.hash = '';
  return u.toString();
}

export const WIPE_AFTER_COUNT = 3;
export const WIPE_AFTER_MS = 5 * 60_000;
export function shouldWipe(u: { count: number; since: number | null }, nowMs: number, minCount = WIPE_AFTER_COUNT, minMs = WIPE_AFTER_MS): boolean {
  return u.since !== null && u.count >= minCount && nowMs - u.since >= minMs;
}

/** Applies the owner's list of switched-off tools; remembers each adapter's configured setting so switching it back on restores that. */
export function applyAdapterOverrides(entries: AdapterEntry[], off: readonly string[], saved: Map<AgentAdapterId, boolean | 'auto'>): boolean {
  let changed = false;
  for (const e of entries) {
    const id = e.adapter.manifest.id as AgentAdapterId;
    if (off.includes(id)) {
      if (!saved.has(id)) saved.set(id, e.settings.enabled);
      if (e.settings.enabled !== false) { e.settings.enabled = false; changed = true; }
    } else if (saved.has(id)) {
      e.settings.enabled = saved.get(id)!;
      saved.delete(id);
      changed = true;
    }
  }
  return changed;
}
