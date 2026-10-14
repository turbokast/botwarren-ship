/**
 * Builds the update manifest and the installers' install-index from already-hashed artifacts. Pure (no I/O); shared by
 * scripts/build-release.mjs (local/dev path) and scripts/assemble-manifest.mjs (the release workflow's sign-manifest job, which must
 * not rebuild anything: it only describes the bytes the reproducible build job produced).
 *
 * A manifest the client would refuse (schema) or the signer could not sign (size) is a build error here, never later.
 */
import { randomBytes } from 'node:crypto';
import { Manifest, MAX_SIGNABLE_MANIFEST_BYTES } from '../../src/update/manifest.ts';

/**
 * @param {object} o
 * @param {string} o.version
 * @param {{ url: string, sha256: string, size: number }} o.bundle
 * @param {Record<string, { url: string, sha256: string, size: number }>} o.full   per target
 * @param {string} [o.minRuntime]
 * @param {object|null} [o.previous]  an ALREADY VERIFIED earlier manifest (its releases, channels, blocked, rollbackFrom are carried over)
 * @param {string} [o.commit]
 * @param {number} [o.manifestVersion]  default previous+1 (or 1): a counter, so the agent's bounded-step rule (verify.ts) holds
 * @param {number} [o.epoch]            default previous epoch (or 1); only recovery-signed keys documents raise the agent's epoch
 * @param {number} [o.expiresDays]
 * @param {Date}   [o.now]
 * @param {number} [o.rolloutBp]
 * @param {boolean} [o.critical]
 * @param {string} [o.stableVersion]
 * @param {string} [o.rolloutSalt]
 * @param {number} [o.keepReleases]     prune the oldest non-current releases beyond this many (default 25) so the manifest stays signable
 */
export function assembleManifest(o) {
  const prev = o.previous ?? null;
  const now = o.now ?? new Date();
  const release = {
    ...(o.commit && /^[0-9a-f]{7,40}$/.test(o.commit) ? { commit: o.commit } : {}),
    protocol: { min: 1, max: 1 }, rolloutBp: o.rolloutBp ?? 10_000,
    rolloutSalt: o.rolloutSalt ?? `r${o.version.replaceAll('.', '-')}-${randomBytes(3).toString('hex')}`, critical: !!o.critical,
    bundle: o.bundle, full: o.full,
    ...(o.minRuntime ? { minRuntime: o.minRuntime } : {}),
  };
  const stable = o.stableVersion ?? o.version;
  let releases = { ...(prev?.releases ?? {}), [o.version]: release };
  const keep = o.keepReleases ?? 25;
  const keys = Object.keys(releases);
  if (keys.length > keep) {
    const protect = new Set([o.version, stable, prev?.channels?.stable, prev?.channels?.beta].filter(Boolean));
    const byAge = keys.filter((v) => !protect.has(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); // oldest first
    for (const v of byAge) { if (Object.keys(releases).length <= keep) break; delete releases[v]; }
  }
  const manifest = {
    schema: 1,
    epoch: o.epoch ?? prev?.epoch ?? 1,
    manifestVersion: o.manifestVersion ?? (prev?.manifestVersion ?? 0) + 1,
    issued: now.toISOString(),
    expires: new Date(now.getTime() + (o.expiresDays ?? 14) * 86_400_000).toISOString(),
    channels: { ...(prev?.channels ?? {}), stable },
    minSupported: prev?.minSupported ?? '0.1.0',
    blocked: prev?.blocked ?? [], rollbackFrom: prev?.rollbackFrom ?? [],
    releases,
  };
  Manifest.parse(manifest); // a manifest that our own client would refuse is a build error
  const text = JSON.stringify(manifest, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_SIGNABLE_MANIFEST_BYTES) throw new Error(`the manifest is ${Buffer.byteLength(text)} bytes, over the ${MAX_SIGNABLE_MANIFEST_BYTES} the release key can sign (Cloud KMS limit 64 KiB): lower --keep-releases`);

  // install index for the shell/PowerShell installers (stable first): "<version> <target> <file> <sha256> <size>"
  const lines = [];
  const versions = Object.keys(manifest.releases).sort((a, b) => (a === manifest.channels.stable ? -1 : b === manifest.channels.stable ? 1 : b.localeCompare(a, undefined, { numeric: true })));
  for (const v of versions) for (const [t, a] of Object.entries(manifest.releases[v].full ?? {})) lines.push(`${v} ${t} ${a.url} ${a.sha256} ${a.size}`);
  return { manifest, text, indexText: lines.join('\n') + (lines.length ? '\n' : '') };
}
