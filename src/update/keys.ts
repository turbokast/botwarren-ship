/**
 * Pinned release PUBLIC keys (Ed25519, SPKI DER, base64). A manifest is accepted only if it verifies under one of these.
 *
 *  - `dev: true` keys exist only so the signing pipeline can be tested end to end. The private half is kept OUTSIDE the
 *    repository by the maintainers and is never committed; only the public half below is published. They are refused unless
 *    BOTWARREN_UPDATE_ALLOW_DEV_KEY=1, and `scripts/build-release.mjs --release` refuses to build while one is listed.
 *  - Production keys (held in a cloud KMS and usable only by the gated release workflow: see docs/RELEASING.md) are ADDED
 *    to this list before the first signed update; the dev key is then deleted. The list form allows rotation: ship a
 *    release that trusts both, sign the next with the new key, then drop the old one.
 */
export interface PinnedKey { id: string; /** SPKI DER, base64 */ spki: string; dev: boolean; /** ISO date after which the key is no longer trusted (optional) */ notAfter?: string }

export const PINNED_PUBLIC_KEYS: readonly PinnedKey[] = [
  { id: 'dev-1', spki: 'MCowBQYDK2VwAyEAl2YWccFmHULX21drEF3MTegbuK33QvVhabdHCKG5HSc=', dev: true },
];
