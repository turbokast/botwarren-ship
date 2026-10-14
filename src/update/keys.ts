/**
 * Pinned PUBLIC keys (Ed25519, SPKI DER, base64) compiled into the agent. Two roles:
 *
 *  - `release` keys sign `manifest.json` (routine releases). The production release key `kms-2026a` is a NON-EXPORTABLE Cloud KMS key
 *    (Google Cloud KMS, EC_SIGN_ED25519, software protection level) that only the gated `sign-manifest` job of the release workflow can use,
 *    through GitHub OIDC workload identity federation: nobody holds its private half (docs/RELEASING.md).
 *  - `recovery` keys (3, offline, age-encrypted, held in separate places) NEVER sign a manifest: a manifest signed by one is refused.
 *    They sign only the keys document (`keys.json`, see trust.ts): any TWO of the THREE can add or rotate release keys, revoke a release
 *    key, and raise the trust epoch. The recovery set itself changes only with a new agent release.
 *
 *  - `dev: true` keys exist only so the signing pipeline can be tested end to end. The private half is kept OUTSIDE the repository by the
 *    maintainers and is never committed; only the public half below is published. They are refused unless
 *    BOTWARREN_UPDATE_ALLOW_DEV_KEY=1, and never produced by CI. (An attacker who can set that variable on the user's machine already
 *    runs code there.) `scripts/build-release.mjs --release` additionally requires the production and recovery keys to be present.
 */
export type KeyRole = 'release' | 'recovery';
export interface PinnedKey {
  id: string;
  /** SPKI DER, base64 */
  spki: string;
  dev: boolean;
  /** default 'release' */
  role?: KeyRole;
  /** ISO date after which the key is no longer trusted (optional) */
  notAfter?: string;
}

export const PINNED_PUBLIC_KEYS: readonly PinnedKey[] = [
  { id: 'dev-1', spki: 'MCowBQYDK2VwAyEAl2YWccFmHULX21drEF3MTegbuK33QvVhabdHCKG5HSc=', dev: true },
  // Production release key: GCP project botwarren-release, key ring botwarren-release (europe-west2), key manifest-signing, version 1.
  { id: 'kms-2026a', spki: 'MCowBQYDK2VwAyEA9wgEUj5KLXm+KZSD9cpJw3B8KmTtGDGL4gudKWPfTuM=', dev: false, role: 'release' },
  // Offline recovery keys (2-of-3 threshold). Generated 2026-10-14 by scripts/recovery-keygen.mjs; private halves are age-encrypted, never in the repo.
  { id: 'recovery-1', spki: 'MCowBQYDK2VwAyEAgh+PRhJvAXPllKqUBsQTCZsJoycIr7hluvOsE4/7qDE=', dev: false, role: 'recovery' },
  { id: 'recovery-2', spki: 'MCowBQYDK2VwAyEATvR3zU+ComOHom/14gbi9EgVvEyEcv8WPjf9X8MG4jE=', dev: false, role: 'recovery' },
  { id: 'recovery-3', spki: 'MCowBQYDK2VwAyEA0o4UlhviMcetJCdw8gpRjnjinf40H10lPNDwlyKgczY=', dev: false, role: 'recovery' },
];

/** minimum number of DISTINCT recovery signatures a keys document needs */
export const RECOVERY_THRESHOLD = 2;

export const roleOf = (k: PinnedKey): KeyRole => k.role ?? 'release';
export const recoveryKeys = (keys: readonly PinnedKey[]): PinnedKey[] => keys.filter((k) => roleOf(k) === 'recovery');
