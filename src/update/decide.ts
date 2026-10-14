/** Pure update decision: given a VERIFIED manifest and local facts, what (if anything) to install. */
import { createHash } from 'node:crypto';
import type { Manifest, Release } from './manifest.ts';
import { compareVersions } from './semver.ts';

export const AGENT_PROTOCOL = 1;

/** Stable per-install rollout bucket 0..9999: uint16(sha256(installId ":" salt)) mod 10000. Decided locally. */
export function rolloutBucket(installId: string, salt: string): number {
  const h = createHash('sha256').update(`${installId}:${salt}`).digest();
  return ((h[0]! << 8) | h[1]!) % 10_000;
}

export type Channel = 'stable' | 'beta';

export interface DecideInput {
  manifest: Manifest;
  current: string;
  channel: Channel;
  installId: string;
  /** versions this install refused after a failed trial: version -> epoch ms until which it is skipped */
  denylist: Readonly<Record<string, number>>;
  nowMs: number;
  /** user pins (config.updates) */
  minimumVersion?: string | undefined;
  maximumVersion?: string | undefined;
  /** `botwarren update --version X` */
  explicitVersion?: string | undefined;
  protocol?: number;
}

export type Reason = 'up_to_date' | 'channel_missing' | 'release_missing' | 'blocked' | 'denylisted' | 'protocol' | 'rollout_not_yet' | 'above_maximum' | 'downgrade_refused';

export type Decision =
  | { action: 'none'; reason: Reason; version?: string }
  | { action: 'update'; version: string; release: Release; /** gate bypassed: critical, below minSupported, or current is blocked */ forced: boolean; rollback: boolean };

export function decideUpdate(i: DecideInput): Decision {
  const m = i.manifest;
  const target = i.explicitVersion ?? m.channels[i.channel];
  if (!target) return { action: 'none', reason: 'channel_missing' };
  const release = m.releases[target];
  if (!release) return { action: 'none', reason: 'release_missing', version: target };
  const cmp = compareVersions(target, i.current);
  const rollbackAllowed = m.rollbackFrom.some((r) => r.from === i.current && r.to === target);
  if (cmp === 0) return { action: 'none', reason: 'up_to_date', version: target };
  if (cmp < 0 && !rollbackAllowed) return { action: 'none', reason: cmp < 0 ? 'downgrade_refused' : 'up_to_date', version: target };
  if (m.blocked.includes(target)) return { action: 'none', reason: 'blocked', version: target };
  const deny = i.denylist[target];
  if (deny !== undefined && deny > i.nowMs) return { action: 'none', reason: 'denylisted', version: target };
  const p = i.protocol ?? AGENT_PROTOCOL;
  if (p < release.protocol.min || p > release.protocol.max) return { action: 'none', reason: 'protocol', version: target };
  if (i.maximumVersion && compareVersions(target, i.maximumVersion) > 0) return { action: 'none', reason: 'above_maximum', version: target };
  const forced = release.critical || compareVersions(i.current, m.minSupported) < 0 || m.blocked.includes(i.current);
  if (!forced && !i.explicitVersion && rolloutBucket(i.installId, release.rolloutSalt) >= release.rolloutBp) return { action: 'none', reason: 'rollout_not_yet', version: target };
  return { action: 'update', version: target, release, forced, rollback: cmp < 0 };
}
