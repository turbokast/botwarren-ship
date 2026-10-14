/**
 * Production key trust: the pinned production release key and the 2-of-3 recovery keys, the keys document (rotate / revoke / epoch),
 * persisted revocations, and refusal of dev keys, single recovery signatures and epoch rollback.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PINNED_PUBLIC_KEYS, RECOVERY_THRESHOLD, recoveryKeys, roleOf, type PinnedKey } from '../../src/update/keys.ts';
import { readTrust, readUpdateState } from '../../src/update/state.ts';
import { KEYS_DOMAIN, applyKeysDoc, effectiveKeys, keysSigFile, signKeysDocBytes, verifyKeysDoc } from '../../src/update/trust.ts';
import { Updater } from '../../src/update/updater.ts';
import { signManifestBytes, verifyManifest } from '../../src/update/verify.ts';
import { KMS_FIXTURE_MANIFEST, KMS_FIXTURE_NOW, KMS_FIXTURE_SIG } from './kms-fixture.ts';
import { NOW, fakeFetch, makeKey, makeManifest, makeRoot, rmTmp, sign, type TestKey } from './kit.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

const withRole = (id: string, role: 'release' | 'recovery'): TestKey => { const k = makeKey(id); return { ...k, pinned: { ...k.pinned, role } }; };
const relA = withRole('rel-a', 'release');
const relB = withRole('rel-b', 'release');
const r1 = withRole('recovery-1', 'recovery');
const r2 = withRole('recovery-2', 'recovery');
const r3 = withRole('recovery-3', 'recovery');
const PINNED_RECOVERY: PinnedKey[] = [relA.pinned, r1.pinned, r2.pinned, r3.pinned]; // a synthetic pinned list: one release key, three recovery keys
const BASE = 'https://downloads.test/';

interface DocSpec { seq: number; epoch?: number; keys?: TestKey[]; revoked?: string[] }
function keysDoc(spec: DocSpec): Buffer {
  return Buffer.from(JSON.stringify({ schema: 1, kind: 'botwarren-keys', seq: spec.seq, epoch: spec.epoch ?? 1, issued: '2026-10-14T00:00:00.000Z', keys: (spec.keys ?? []).map((k) => ({ id: k.pinned.id, spki: k.pinned.spki })), revoked: spec.revoked ?? [] }, null, 2));
}
const signDoc = (bytes: Buffer, signers: TestKey[]): string => keysSigFile(signers.map((s) => signKeysDocBytes(bytes, s.pem, s.pinned.id)));

describe('the pinned production keys', () => {
  it('pins exactly: the dev key (refused), the production KMS release key, and three distinct recovery keys; all Ed25519 SPKI', () => {
    const dev = PINNED_PUBLIC_KEYS.filter((k) => k.dev);
    const prod = PINNED_PUBLIC_KEYS.filter((k) => !k.dev && roleOf(k) === 'release');
    const rec = recoveryKeys(PINNED_PUBLIC_KEYS);
    expect(dev.map((k) => k.id)).toEqual(['dev-1']);
    expect(prod.map((k) => k.id)).toEqual(['kms-2026a']);
    expect(rec.map((k) => k.id)).toEqual(['recovery-1', 'recovery-2', 'recovery-3']);
    expect(rec.length).toBeGreaterThan(RECOVERY_THRESHOLD);
    expect(new Set(PINNED_PUBLIC_KEYS.map((k) => k.spki)).size).toBe(PINNED_PUBLIC_KEYS.length);
    expect(new Set(PINNED_PUBLIC_KEYS.map((k) => k.id)).size).toBe(PINNED_PUBLIC_KEYS.length);
    for (const k of PINNED_PUBLIC_KEYS) expect(Buffer.from(k.spki, 'base64')).toHaveLength(44);
    expect(rec.every((k) => !k.dev)).toBe(true);
  });

  it('a manifest signed by the REAL production KMS key (fixture from Cloud KMS) is accepted with the pinned list and no opt-in', () => {
    const r = verifyManifest(Buffer.from(KMS_FIXTURE_MANIFEST), KMS_FIXTURE_SIG, { keys: PINNED_PUBLIC_KEYS, now: KMS_FIXTURE_NOW, highestSeen: 0 });
    expect(r).toMatchObject({ ok: true, keyId: 'kms-2026a' });
    // one flipped byte, and a signature for another key id, are refused
    const t = Buffer.from(KMS_FIXTURE_MANIFEST); t[t.indexOf(Buffer.from('0.0.1'))] = 0x39;
    expect(verifyManifest(t, KMS_FIXTURE_SIG, { keys: PINNED_PUBLIC_KEYS, now: KMS_FIXTURE_NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'bad_signature' });
    expect(verifyManifest(Buffer.from(KMS_FIXTURE_MANIFEST), KMS_FIXTURE_SIG.replace('kms-2026a', 'recovery-1'), { keys: PINNED_PUBLIC_KEYS, now: KMS_FIXTURE_NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'wrong_key_role' });
  });

  it('a DEV-signed manifest is refused with the real pinned list (dev-1 is trusted only with the explicit opt-in)', () => {
    const { bytes } = sign(makeManifest({ stable: '0.5.0', releases: [{ version: '0.5.0' }] }).manifest, makeKey());
    const claimsDev = signManifestBytes(bytes, makeKey().pem, 'dev-1');
    expect(verifyManifest(bytes, claimsDev, { keys: PINNED_PUBLIC_KEYS, now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'dev_key_refused' });
    // with the opt-in the key is considered, and a forged signature still fails
    expect(verifyManifest(bytes, claimsDev, { keys: PINNED_PUBLIC_KEYS, now: NOW, highestSeen: 0, allowDev: true })).toEqual({ ok: false, code: 'bad_signature' });
  });

  it('a recovery key can never sign a manifest (routine releases are the release key only)', () => {
    const { bytes, sig } = sign(makeManifest({ stable: '0.5.0', releases: [{ version: '0.5.0' }] }).manifest, r1);
    expect(verifyManifest(bytes, sig, { keys: PINNED_RECOVERY, now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'wrong_key_role' });
  });
});

describe('keys document: 2-of-3 recovery threshold', () => {
  const bytes = keysDoc({ seq: 1, keys: [relB], revoked: ['rel-a'] });
  const verify = (sigText: string, pinned: readonly PinnedKey[] = PINNED_RECOVERY) => verifyKeysDoc(bytes, sigText, { pinned, now: NOW });

  it('two distinct recovery signatures are enough, in any order and in any pair', () => {
    for (const pair of [[r1, r2], [r3, r1], [r2, r3], [r3, r2, r1]]) expect(verify(signDoc(bytes, pair)).ok, pair.map((p) => p.pinned.id).join('+')).toBe(true);
  });

  it('ONE recovery key is insufficient; the same key twice counts once; release, dev, unknown and wrong-domain signatures do not count', () => {
    expect(verify(signDoc(bytes, [r1]))).toEqual({ ok: false, code: 'insufficient_signatures' });
    expect(verify(signDoc(bytes, [r1, r1, r1]))).toEqual({ ok: false, code: 'insufficient_signatures' });
    expect(verify(signDoc(bytes, [r1, relA]))).toEqual({ ok: false, code: 'insufficient_signatures' }); // a release key is not a recovery key
    expect(verify(signDoc(bytes, [r1, withRole('recovery-9', 'recovery')]))).toEqual({ ok: false, code: 'insufficient_signatures' }); // unknown id
    // r2 signs the right bytes under the MANIFEST domain: not a keys-document signature
    const manifestStyle = signManifestBytes(bytes, r2.pem, 'recovery-2');
    const wrongDomain = keysSigFile([signKeysDocBytes(bytes, r1.pem, 'recovery-1'), { keyId: 'recovery-2', sig: JSON.parse(manifestStyle).sig }]);
    expect(verify(wrongDomain)).toEqual({ ok: false, code: 'insufficient_signatures' });
    expect(KEYS_DOMAIN.toString()).not.toBe('botwarren-manifest-v1\0');
  });

  it('a signature claiming another recovery key id fails; a tampered document fails', () => {
    const swapped = keysSigFile([{ keyId: 'recovery-1', sig: signKeysDocBytes(bytes, r1.pem, 'x').sig }, { keyId: 'recovery-2', sig: signKeysDocBytes(bytes, r3.pem, 'x').sig }]);
    expect(verify(swapped)).toEqual({ ok: false, code: 'insufficient_signatures' });
    const t = Buffer.from(bytes); t[t.indexOf(Buffer.from('rel-a'))] = 0x58;
    expect(verifyKeysDoc(t, signDoc(bytes, [r1, r2]), { pinned: PINNED_RECOVERY, now: NOW })).toEqual({ ok: false, code: 'insufficient_signatures' });
  });

  it('cannot redefine a pinned key id, add a recovery key, or revoke a recovery key', () => {
    const redefine = keysDoc({ seq: 1, keys: [{ ...relB, pinned: { ...relB.pinned, id: 'rel-a' } }] });
    expect(verifyKeysDoc(redefine, signDoc(redefine, [r1, r2]), { pinned: PINNED_RECOVERY, now: NOW })).toEqual({ ok: false, code: 'conflicts_with_pinned' });
    const revokeRecovery = keysDoc({ seq: 1, revoked: ['recovery-2'] });
    expect(verifyKeysDoc(revokeRecovery, signDoc(revokeRecovery, [r1, r3]), { pinned: PINNED_RECOVERY, now: NOW })).toEqual({ ok: false, code: 'conflicts_with_pinned' });
    const garbage = Buffer.from('{"schema":1}');
    expect(verifyKeysDoc(garbage, signDoc(garbage, [r1, r2]), { pinned: PINNED_RECOVERY, now: NOW })).toEqual({ ok: false, code: 'malformed' });
  });
});

describe('applyKeysDoc / effectiveKeys (pure)', () => {
  it('sequence must increase (replays ignored), epoch may not go down, revocations accumulate', () => {
    const empty = { keysSeq: 0, epoch: 1, revoked: [], added: [] };
    const d1 = verifyKeysDoc(keysDoc({ seq: 1, epoch: 2, keys: [relB], revoked: ['rel-a'] }), signDoc(keysDoc({ seq: 1, epoch: 2, keys: [relB], revoked: ['rel-a'] }), [r1, r2]), { pinned: PINNED_RECOVERY, now: NOW });
    if (!d1.ok) throw new Error('setup');
    const a1 = applyKeysDoc(empty, d1.doc);
    expect(a1).toMatchObject({ applied: true, epochRaised: true, state: { keysSeq: 1, epoch: 2, revoked: ['rel-a'] } });
    if (!a1.applied) return;
    expect(applyKeysDoc(a1.state, d1.doc)).toEqual({ applied: false, reason: 'not_newer' });
    const low = verifyKeysDoc(keysDoc({ seq: 5, epoch: 1 }), signDoc(keysDoc({ seq: 5, epoch: 1 }), [r1, r2]), { pinned: PINNED_RECOVERY, now: NOW });
    if (!low.ok) throw new Error('setup');
    expect(applyKeysDoc(a1.state, low.doc)).toEqual({ applied: false, reason: 'epoch_rollback' });
    const more = verifyKeysDoc(keysDoc({ seq: 6, epoch: 2, revoked: ['rel-b'] }), signDoc(keysDoc({ seq: 6, epoch: 2, revoked: ['rel-b'] }), [r2, r3]), { pinned: PINNED_RECOVERY, now: NOW });
    if (!more.ok) throw new Error('setup');
    const a2 = applyKeysDoc(a1.state, more.doc);
    expect(a2).toMatchObject({ applied: true, epochRaised: false, state: { revoked: ['rel-a', 'rel-b'], added: [] } });
    if (a2.applied) expect(effectiveKeys(PINNED_RECOVERY, a2.state).map((k) => k.id)).toEqual(['rel-a', 'recovery-1', 'recovery-2', 'recovery-3']); // revoked ids stay listed so verify says key_revoked
  });
});

describe('end to end in the Updater: recovery rotates and revokes, persisted across restarts', () => {
  function world() {
    const root = makeRoot('0.4.0');
    cleanup.push(() => rmTmp(root));
    const files = new Map<string, Buffer | string>();
    const publish = (key: TestKey, o: { manifestVersion: number; epoch?: number; stable: string }) => {
      const { manifest, bundles } = makeManifest({ manifestVersion: o.manifestVersion, ...(o.epoch ? { epoch: o.epoch } : {}), stable: o.stable, releases: [{ version: o.stable }, { version: '0.4.0' }] });
      const s = sign(manifest, key);
      files.set('manifest.json', s.bytes); files.set('manifest.json.sig', s.sig);
      for (const [k, v] of bundles) files.set(k, v);
    };
    const publishKeys = (spec: DocSpec, signers: TestKey[]) => { const b = keysDoc(spec); files.set('keys.json', b); files.set('keys.json.sig', signDoc(b, signers)); };
    // a fresh Updater per call = an agent restart (only the files under `root` carry over)
    const check = async (current = '0.4.0') => {
      const logs: string[] = [];
      const u = new Updater({ root, baseUrl: BASE, currentVersion: current, channel: 'stable', platform: 'linux-x64', fetchImpl: fakeFetch(files).impl, keys: PINNED_RECOVERY, now: () => NOW.getTime(), rand: () => 0.5, selftest: async () => true, log: (m) => logs.push(m) });
      return { out: await u.check({ dryRun: false }), logs };
    };
    return { root, publish, publishKeys, check };
  }

  it('the release key works; recovery 2-of-3 rotates to rel-b and revokes rel-a; the old key is then refused, even after a restart', async () => {
    const w = world();
    w.publish(relA, { manifestVersion: 1, stable: '0.5.0' });
    expect((await w.check()).out).toMatchObject({ status: 'staged', version: '0.5.0' });

    w.publishKeys({ seq: 1, keys: [relB], revoked: ['rel-a'] }, [r1, r3]);
    w.publish(relA, { manifestVersion: 2, stable: '0.6.0' }); // the compromised key signs a newer manifest
    const refused = await w.check('0.5.0');
    expect(refused.out).toEqual({ status: 'error', code: 'key_revoked' });
    expect(refused.logs.join('\n')).toContain('keys document 1 accepted (signed by recovery-1, recovery-3');
    expect(readTrust(w.root)).toMatchObject({ keysSeq: 1, epoch: 1, revoked: ['rel-a'], added: [{ id: 'rel-b' }] });

    w.publish(relB, { manifestVersion: 2, stable: '0.6.0' });
    expect((await w.check('0.5.0')).out).toMatchObject({ status: 'staged', version: '0.6.0' });

    // restart with the keys document GONE from the host: the revocation is persisted, an old rel-a signature stays refused
    w.publish(relA, { manifestVersion: 3, stable: '0.7.0' });
    expect((await w.check('0.6.0')).out).toEqual({ status: 'error', code: 'key_revoked' });
  });

  it('ONE recovery key cannot rotate or revoke: the document is ignored and the old key still works', async () => {
    const w = world();
    w.publishKeys({ seq: 1, keys: [relB], revoked: ['rel-a'] }, [r2]);
    w.publish(relA, { manifestVersion: 1, stable: '0.5.0' });
    const r = await w.check();
    expect(r.out).toMatchObject({ status: 'staged', version: '0.5.0' });
    expect(r.logs.join('\n')).toContain('keys document refused (insufficient_signatures)');
    expect(readTrust(w.root)).toMatchObject({ keysSeq: 0, revoked: [], added: [] });
    w.publish(relB, { manifestVersion: 2, stable: '0.6.0' });
    expect((await w.check('0.5.0')).out).toEqual({ status: 'error', code: 'unknown_key' }); // rel-b was never trusted
  });

  it('epoch rollback is refused; a manifest from a future epoch is refused; an older keys document cannot lower the epoch', async () => {
    const w = world();
    w.publish(relA, { manifestVersion: 1, stable: '0.5.0' });
    await w.check();
    w.publishKeys({ seq: 1, epoch: 2, keys: [relB], revoked: ['rel-a'] }, [r1, r2]);
    w.publish(relB, { manifestVersion: 1, epoch: 2, stable: '0.6.0' });
    expect((await w.check('0.5.0')).out).toMatchObject({ status: 'staged', version: '0.6.0' });
    expect(readTrust(w.root).epoch).toBe(2);

    w.publish(relB, { manifestVersion: 9, epoch: 1, stable: '0.7.0' }); // validly signed, but a lower epoch
    expect((await w.check('0.6.0')).out).toEqual({ status: 'error', code: 'epoch_rollback' });
    w.publish(relB, { manifestVersion: 9, epoch: 3, stable: '0.7.0' }); // a release key may not raise the epoch
    expect((await w.check('0.6.0')).out).toEqual({ status: 'error', code: 'epoch_unknown' });

    w.publishKeys({ seq: 2, epoch: 1, keys: [relA] }, [r1, r2]); // a newer sequence number cannot lower the epoch or un-revoke
    w.publish(relA, { manifestVersion: 10, epoch: 1, stable: '0.7.0' });
    const r = await w.check('0.6.0');
    expect(r.out).toEqual({ status: 'error', code: 'key_revoked' }); // the epoch-1 document did not un-revoke rel-a (and epoch 1 < 2 anyway)
    expect(readTrust(w.root)).toMatchObject({ keysSeq: 1, epoch: 2, revoked: ['rel-a'] });
  });

  it('a version-jump freeze (online key signs a huge manifestVersion) is bounded, and an epoch bump recovers from a smaller one', async () => {
    const w = world();
    w.publish(relA, { manifestVersion: 1, stable: '0.5.0' });
    await w.check();
    w.publish(relA, { manifestVersion: 5000, stable: '0.5.1' });
    expect((await w.check('0.5.0')).out).toEqual({ status: 'error', code: 'version_jump' });
    w.publish(relA, { manifestVersion: 1001, stable: '0.5.1' }); // within the bound: accepted, and now legitimate manifests look old
    expect((await w.check('0.5.0')).out).toMatchObject({ status: 'staged', version: '0.5.1' });
    expect(readUpdateState(w.root).highestManifestVersion).toBe(1001);
    w.publish(relA, { manifestVersion: 2, stable: '0.5.2' });
    expect((await w.check('0.5.1')).out).toEqual({ status: 'error', code: 'rollback' });
    // recovery: epoch 2, rotate the key; the per-epoch counter starts again
    w.publishKeys({ seq: 1, epoch: 2, keys: [relB], revoked: ['rel-a'] }, [r2, r3]);
    w.publish(relB, { manifestVersion: 2, epoch: 2, stable: '0.5.2' });
    expect((await w.check('0.5.1')).out).toMatchObject({ status: 'staged', version: '0.5.2' });
    expect(readUpdateState(w.root).highestManifestVersion).toBe(2);
  });
});

describe('a generated Ed25519 key is a valid pin (sanity for the test kit)', () => {
  it('has a 44-byte SPKI', () => {
    expect(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })).toHaveLength(44);
  });
});
