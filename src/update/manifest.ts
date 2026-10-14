/**
 * Release manifest (signed, detached signature; see verify.ts). The manifest is the ONLY source of truth for what may
 * be installed: nothing is downloaded or executed that is not listed here with a matching sha256.
 */
import { z } from 'zod';
import { isVersion } from './semver.ts';

export const PLATFORMS = ['win-x64', 'win-arm64', 'mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64'] as const;
export const Platform = z.enum(PLATFORMS);
export type Platform = z.infer<typeof Platform>;

export const Version = z.string().refine(isVersion, 'x.y.z');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const Artifact = z.object({
  /** absolute https URL, or a path relative to the manifest's base URL */
  url: z.string().min(1).max(1024),
  sha256: Sha256,
  size: z.number().int().min(1).max(250 * 1024 * 1024),
}).strict();
export type Artifact = z.infer<typeof Artifact>;

export const Release = z.object({
  /** git commit the release was built from (provenance; reproducible build check) */
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  /** agent <-> server protocol range this release speaks */
  protocol: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict(),
  /** staged rollout in basis points (0..10000); the install's own bucket decides, the server learns nothing */
  rolloutBp: z.number().int().min(0).max(10_000),
  rolloutSalt: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** critical releases skip the rollout gate (still need a valid signature and hash) */
  critical: z.boolean().default(false),
  /** platform-independent app bundle (zip: agent.mjs, cli.mjs, ops.html, VERSION) used by the silent updater */
  bundle: Artifact,
  /** per-platform full archives (runtime + launcher + bundle) used by the installers and package managers */
  full: z.partialRecord(Platform, Artifact).default({}),
  /** the Node runtime the bundle needs at least; an older installed runtime means "a new installer is required" */
  minRuntime: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/).optional(),
}).strict();
export type Release = z.infer<typeof Release>;

export const Manifest = z.object({
  schema: z.literal(1),
  /** strictly monotonic; a manifest older than the highest one ever seen is refused (rollback/freeze protection) */
  manifestVersion: z.number().int().min(1),
  issued: z.string().datetime({ offset: true }),
  expires: z.string().datetime({ offset: true }),
  channels: z.object({ stable: Version, beta: Version.optional() }).strict(),
  /** installs below this must update (rollout gate bypassed) */
  minSupported: Version,
  /** versions that must not run or be installed; an install on one of them updates at once */
  blocked: z.array(Version).max(200).default([]),
  /** signed, explicit downgrades: an install on `from` may move to `to` */
  rollbackFrom: z.array(z.object({ from: Version, to: Version }).strict()).max(50).default([]),
  releases: z.record(Version, Release),
}).strict();
export type Manifest = z.infer<typeof Manifest>;

export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** `${process.platform}-${process.arch}` -> manifest platform key, or null when unsupported. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): Platform | null {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : null;
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !a) return null;
  const k = `${os}-${a}`;
  return (PLATFORMS as readonly string[]).includes(k) ? (k as Platform) : null;
}
