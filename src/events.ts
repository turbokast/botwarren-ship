/** Canonical event builders shared by the session adapter and the run wrapper. Metadata only. */
import { createHash } from 'node:crypto';
import type { CanonicalEventInput, Effort, ModelFamily, ModelMaker } from './vendor/core/contract.ts';

export const sha = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');

export type Role = 'main' | 'subagent' | 'pair';

export function sessionObserved(o: {
  instance: string; key: string; status: 'working' | 'idle'; projectId: string | null; at: Date; priv: Record<string, string | number | boolean | null>;
  harness?: 'claude' | 'codex'; role?: Role; parentKey?: string; maker?: ModelMaker; model?: ModelFamily; effort?: Effort;
}): CanonicalEventInput {
  const at = o.at.toISOString();
  return {
    schemaVersion: 1, eventId: `ship-${sha(o.key, o.status, o.role ?? 'main', o.parentKey ?? '', at).slice(0, 32)}`, source: 'collector', sourceInstance: o.instance,
    sourceEventId: `${o.key}@${at}`.slice(0, 256), occurredAt: at, observedAt: at, type: 'session.observed',
    sessionKey: o.key, harness: o.harness ?? 'claude', status: o.status, projectId: o.projectId,
    // Log-derived: always `inferred`, never `observed`. No attribution -> nothing is published.
    attribution: o.projectId ? { method: 'cwd_registry', certainty: 'inferred' } : { method: 'none', certainty: 'unknown' },
    workCategory: 'unknown',
    role: o.role ?? 'main',
    ...(o.parentKey ? { parentKey: o.parentKey } : {}),
    ...(o.maker ? { maker: o.maker } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.effort ? { effort: o.effort } : {}),
    private: o.priv,
  };
}

export function sessionEnded(instance: string, key: string, at: Date): CanonicalEventInput {
  const iso = at.toISOString();
  return {
    schemaVersion: 1, eventId: `ship-${sha(key, 'ended', iso).slice(0, 32)}`, source: 'collector', sourceInstance: instance,
    sourceEventId: `${key}@end@${iso}`.slice(0, 256), occurredAt: iso, observedAt: iso, type: 'session.ended', sessionKey: key, reason: 'unknown',
  };
}

/**
 * The only collector-health enum values are herdr|gitlab|github; the ship's session feed is reported
 * as `herdr` (the "workers feed").
 */
export function heartbeat(instance: string, health: 'healthy' | 'delayed' | 'disconnected' | 'recovering', at: Date): CanonicalEventInput {
  const iso = at.toISOString();
  return {
    schemaVersion: 1, eventId: `hb-${sha('ship', health, iso).slice(0, 24)}`, source: 'collector', sourceInstance: instance,
    sourceEventId: `hb:ship:${iso}`, occurredAt: iso, observedAt: iso, type: 'collector.heartbeat', collector: 'herdr', health,
  };
}
