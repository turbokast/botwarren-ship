/**
 * The keys document: how the OFFLINE recovery keys (2 of 3) rotate and revoke the online release key, and raise the trust epoch.
 *
 *   keys.json      {"schema":1,"kind":"botwarren-keys","seq":N,"epoch":E,"issued":...,"keys":[{id,spki,notAfter?}],"revoked":[id...]}
 *   keys.json.sig  {"alg":"ed25519","sigs":[{"keyId":"recovery-1","sig":"<b64>"},{"keyId":"recovery-3","sig":"<b64>"}]}
 *   signed message = "botwarren-keys-v1\0" || exact keys.json bytes   (a different domain from manifests: never interchangeable)
 *
 * Rules (all enforced by the agent, all tested):
 *  - valid only with signatures by at least RECOVERY_THRESHOLD (2) DISTINCT pinned recovery keys; duplicates, unknown ids, release keys and
 *    dev keys do not count; one signature is never enough
 *  - `seq` must exceed the persisted one (replay of an older document is ignored); `epoch` may not go down
 *  - the document lists the CURRENT non-pinned release keys (it replaces the previously added set) and the revoked ids (a permanent union)
 *  - it cannot redefine a pinned id, cannot add recovery keys, and cannot revoke recovery keys (the recovery set changes only with a new agent release)
 *  - the agent persists the result (state.ts `trust.json`) so revocations survive restarts and later replays of old signatures are refused
 *
 * The signed manifest then must use the persisted epoch (verify.ts), a revoked key id is refused outright, and a recovery key can never sign a manifest.
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { z } from 'zod';
import { COMPONENT_PUBLIC_KEYS, RECOVERY_THRESHOLD, recoveryKeys, type PinnedKey } from './keys.ts';
import type { AddedKey, TrustState } from './state.ts';

export const KEYS_DOMAIN = Buffer.from('botwarren-keys-v1\0', 'utf8');
export const MAX_KEYS_DOC_BYTES = 64 * 1024;

const KeyId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const Spki = z.string().regex(/^[A-Za-z0-9+/]{59}=$/);
const SigB64 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);

export const KeysDoc = z.object({
  schema: z.literal(1),
  kind: z.literal('botwarren-keys'),
  seq: z.number().int().min(1).max(1_000_000_000),
  epoch: z.number().int().min(1).max(10_000),
  issued: z.string().datetime({ offset: true }),
  keys: z.array(z.object({ id: KeyId, spki: Spki, notAfter: z.string().datetime({ offset: true }).optional() }).strict()).max(8),
  revoked: z.array(KeyId).max(64),
}).strict();
export type KeysDoc = z.infer<typeof KeysDoc>;

const KeysSigFile = z.object({ alg: z.literal('ed25519'), sigs: z.array(z.object({ keyId: KeyId, sig: SigB64 }).strict()).min(1).max(8) }).strict();

export type KeysCode = 'too_large' | 'bad_signature_file' | 'insufficient_signatures' | 'malformed' | 'conflicts_with_pinned';
export type KeysVerify = { ok: true; doc: KeysDoc; signers: string[] } | { ok: false; code: KeysCode };

const spkiKey = (spki: string) => createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });

export function verifyKeysDoc(bytes: Buffer, sigText: string, o: { pinned: readonly PinnedKey[]; now: Date }): KeysVerify {
  if (bytes.length > MAX_KEYS_DOC_BYTES) return { ok: false, code: 'too_large' };
  let sf: z.infer<typeof KeysSigFile>;
  try { sf = KeysSigFile.parse(JSON.parse(sigText)); } catch { return { ok: false, code: 'bad_signature_file' }; }
  const msg = Buffer.concat([KEYS_DOMAIN, bytes]);
  const signers = new Set<string>();
  for (const s of sf.sigs) {
    if (signers.has(s.keyId)) continue; // the same key twice counts once
    const k = recoveryKeys(o.pinned).find((r) => r.id === s.keyId);
    if (!k || (k.notAfter && Date.parse(k.notAfter) < o.now.getTime())) continue; // only pinned, unexpired RECOVERY keys count
    try { if (edVerify(null, msg, spkiKey(k.spki), Buffer.from(s.sig, 'base64'))) signers.add(k.id); } catch { /* not a signature */ }
  }
  if (signers.size < RECOVERY_THRESHOLD) return { ok: false, code: 'insufficient_signatures' }; // nothing is parsed before the threshold is met
  let doc: KeysDoc;
  try { doc = KeysDoc.parse(JSON.parse(bytes.toString('utf8'))); } catch { return { ok: false, code: 'malformed' }; }
  // the component keys are pinned too: a document may not redefine one of their ids, nor register a component key as an agent release key
  const pinnedIds = new Set([...o.pinned, ...COMPONENT_PUBLIC_KEYS].map((k) => k.id));
  const componentSpkis = new Set(COMPONENT_PUBLIC_KEYS.map((k) => k.spki));
  const recoveryIds = new Set(recoveryKeys(o.pinned).map((k) => k.id));
  if (doc.keys.some((k) => pinnedIds.has(k.id) || componentSpkis.has(k.spki)) || doc.revoked.some((id) => recoveryIds.has(id))) return { ok: false, code: 'conflicts_with_pinned' };
  if (new Set(doc.keys.map((k) => k.id)).size !== doc.keys.length) return { ok: false, code: 'malformed' };
  try { for (const k of doc.keys) if (spkiKey(k.spki).asymmetricKeyType !== 'ed25519') return { ok: false, code: 'malformed' }; } catch { return { ok: false, code: 'malformed' }; }
  return { ok: true, doc, signers: [...signers].sort() };
}

export type ApplyResult = { applied: true; state: TrustState; epochRaised: boolean } | { applied: false; reason: 'not_newer' | 'epoch_rollback' };

/** Pure: the new persisted trust after a VERIFIED keys document, or why it changes nothing. */
export function applyKeysDoc(state: TrustState, doc: KeysDoc): ApplyResult {
  if (doc.seq <= state.keysSeq) return { applied: false, reason: 'not_newer' };
  if (doc.epoch < state.epoch) return { applied: false, reason: 'epoch_rollback' };
  const revoked = [...new Set([...state.revoked, ...doc.revoked])].sort();
  const added: AddedKey[] = doc.keys.filter((k) => !revoked.includes(k.id)).map((k) => ({ id: k.id, spki: k.spki, ...(k.notAfter ? { notAfter: k.notAfter } : {}) }));
  return { applied: true, state: { keysSeq: doc.seq, epoch: doc.epoch, revoked, added }, epochRaised: doc.epoch > state.epoch };
}

/**
 * The key list manifests are verified against: pinned keys plus document-added release keys. Revoked ids are NOT removed here: verifyManifest
 * is given `state.revoked` and refuses them with `key_revoked` (a clearer failure than "unknown key"); revoked document keys are never added.
 */
export function effectiveKeys(pinned: readonly PinnedKey[], state: TrustState): PinnedKey[] {
  const revoked = new Set(state.revoked);
  const out = [...pinned];
  for (const a of state.added) if (!revoked.has(a.id) && !out.some((k) => k.id === a.id)) out.push({ id: a.id, spki: a.spki, dev: false, role: 'release', ...(a.notAfter ? { notAfter: a.notAfter } : {}) });
  return out;
}

/** Offline signing (scripts/release-sign.mjs --recovery-*): one recovery signature over the exact keys.json bytes. */
export function signKeysDocBytes(bytes: Buffer, privateKeyPem: string | Buffer, keyId: string): { keyId: string; sig: string } {
  return { keyId, sig: edSign(null, Buffer.concat([KEYS_DOMAIN, bytes]), createPrivateKey(privateKeyPem)).toString('base64') };
}

export function keysSigFile(parts: { keyId: string; sig: string }[]): string {
  return JSON.stringify({ alg: 'ed25519', sigs: parts }) + '\n';
}
