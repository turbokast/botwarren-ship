/**
 * KEY separation between agent updates and the optional components, in both directions (the domain separation is tested in install.test.ts and
 * verify.test.ts); the signing script's side is in monorepo-tests/component-sign-keys.test.ts. The agent-update key set (PINNED_PUBLIC_KEYS) and the component key set (COMPONENT_PUBLIC_KEYS) never verify each other's manifests,
 * whichever key list a caller passes, and the keys document cannot register a component key as an agent release key.
 */
import { describe, expect, it } from 'vitest';
import { COMPONENT_KEY_IS_PLACEHOLDER, COMPONENT_KEY_RAW_B64, COMPONENT_PUBLIC_KEYS, PINNED_PUBLIC_KEYS, roleOf, spkiFromRaw, type PinnedKey } from '../../src/update/keys.ts';
import { signManifestBytes, verifyManifest } from '../../src/update/verify.ts';
import { signComponentBytes, verifyComponentManifest } from '../../src/component/verify.ts';
import { KEYS_DOMAIN, keysSigFile, signKeysDocBytes, verifyKeysDoc } from '../../src/update/trust.ts';
import { makeKey } from '../update/kit.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const bytes = Buffer.from('{"not":"parsed before the signature is checked"}');

describe('the pinned component key set', () => {
  it('is separate from the agent-update set: other ids, other keys, role component, well-formed', () => {
    expect(COMPONENT_PUBLIC_KEYS.length).toBeGreaterThan(0);
    for (const k of COMPONENT_PUBLIC_KEYS) { expect(roleOf(k), k.id).toBe('component'); expect(Buffer.from(k.spki, 'base64'), k.id).toHaveLength(44); }
    expect(new Set(COMPONENT_PUBLIC_KEYS.map((k) => k.id)).size).toBe(COMPONENT_PUBLIC_KEYS.length);
    const agentIds = new Set(PINNED_PUBLIC_KEYS.map((k) => k.id)); const agentSpkis = new Set(PINNED_PUBLIC_KEYS.map((k) => k.spki));
    for (const k of COMPONENT_PUBLIC_KEYS) { expect(agentIds.has(k.id), k.id).toBe(false); expect(agentSpkis.has(k.spki), k.id).toBe(false); }
    for (const k of PINNED_PUBLIC_KEYS) expect(roleOf(k), k.id).not.toBe('component');
    expect(COMPONENT_PUBLIC_KEYS.filter((k) => k.dev).every((k) => k.id.startsWith('dev-'))).toBe(true);
    expect(COMPONENT_PUBLIC_KEYS.find((k) => k.id === 'kms-comp-2026a')).toBeDefined();
  });

  it('the production key is derived from the raw 32-byte public key constant, and a placeholder is flagged so nothing can be signed with it', () => {
    const prod = COMPONENT_PUBLIC_KEYS.find((k) => k.id === 'kms-comp-2026a')!;
    expect(Buffer.from(COMPONENT_KEY_RAW_B64, 'base64')).toHaveLength(32);
    expect(prod.spki).toBe(spkiFromRaw(COMPONENT_KEY_RAW_B64));
    expect(prod.dev).toBe(false);
    // the real public key of the Cloud KMS key component-signing, version 1 (pinned 2026-10-15)
    expect(prod.spki).toBe('MCowBQYDK2VwAyEARv4WZoMAzdHQbQkIvHZpgGD/Pa6GXtwXN1Ql66vUVD4=');
    expect(COMPONENT_KEY_IS_PLACEHOLDER).toBe(false);
    expect(prod.placeholder === true).toBe(COMPONENT_KEY_IS_PLACEHOLDER);
    expect(() => spkiFromRaw('AAAA')).toThrow();
  });
});

describe('the component verifier never accepts an agent-update key; the agent-update verifier never accepts a component key', () => {
  const compKey = makeKey('kms-comp-2026a', false, 'component');
  const agentKey = makeKey('kms-2026a', false);

  it('component manifest: a manifest signed by the agent-update key id is unknown with the default keys, and wrong_key_role if the caller passes the agent key list', () => {
    const sig = signComponentBytes(bytes, agentKey.pem, 'kms-2026a');
    expect(verifyComponentManifest(bytes, sig, { component: 'companion', now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'unknown_key' });
    expect(verifyComponentManifest(bytes, sig, { component: 'companion', keys: PINNED_PUBLIC_KEYS, now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'wrong_key_role' });
    expect(verifyComponentManifest(bytes, sig, { component: 'companion', keys: [agentKey.pinned], now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'wrong_key_role' });
    // the recovery keys, as before
    const sigR = signComponentBytes(bytes, agentKey.pem, 'recovery-1');
    expect(verifyComponentManifest(bytes, sigR, { component: 'companion', keys: PINNED_PUBLIC_KEYS, now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'wrong_key_role' });
  });

  it('agent update manifest: a manifest signed by a component key id is unknown with the default keys, and wrong_key_role if the caller passes the component key list', () => {
    for (const id of ['kms-comp-2026a', 'dev-comp-1']) {
      const sig = signManifestBytes(bytes, compKey.pem, id);
      expect(verifyManifest(bytes, sig, { now: NOW, highestSeen: 0 }), id).toEqual({ ok: false, code: 'unknown_key' });
      expect(verifyManifest(bytes, sig, { keys: COMPONENT_PUBLIC_KEYS, now: NOW, highestSeen: 0, allowDev: true }), id).toEqual({ ok: false, code: 'wrong_key_role' });
    }
    expect(verifyManifest(bytes, signManifestBytes(bytes, compKey.pem, 'kms-comp-2026a'), { keys: [compKey.pinned], now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'wrong_key_role' });
  });

  it('even a component key tagged as a release key cannot move a signature across domains', () => {
    const asRelease: PinnedKey = { ...compKey.pinned, role: 'release' };
    // signed for components, shown to the agent-update verifier: the domain differs
    expect(verifyManifest(bytes, signComponentBytes(bytes, compKey.pem, compKey.pinned.id), { keys: [asRelease], now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'bad_signature' });
    // signed for agent updates, shown to the component verifier
    expect(verifyComponentManifest(bytes, signManifestBytes(bytes, compKey.pem, compKey.pinned.id), { component: 'companion', keys: [compKey.pinned], now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'bad_signature' });
  });
});

describe('the keys document cannot blur the two key sets', () => {
  const recovery = [makeKey('recovery-1', false, 'recovery'), makeKey('recovery-2', false, 'recovery'), makeKey('recovery-3', false, 'recovery')];
  const pinned = recovery.map((r) => r.pinned);
  const signed = (doc: object): { b: Buffer; sig: string } => {
    const b = Buffer.from(JSON.stringify({ schema: 1, kind: 'botwarren-keys', seq: 1, epoch: 1, issued: '2026-10-14T00:00:00.000Z', revoked: [], ...doc }));
    return { b, sig: keysSigFile([signKeysDocBytes(b, recovery[0]!.pem, 'recovery-1'), signKeysDocBytes(b, recovery[1]!.pem, 'recovery-2')]) };
  };

  it('refuses to register a component key (by id or by key material) as an agent release key; an ordinary new release key is still fine', () => {
    const prod = COMPONENT_PUBLIC_KEYS.find((k) => k.id === 'kms-comp-2026a')!;
    const byId = signed({ keys: [{ id: 'kms-comp-2026a', spki: makeKey('x').pinned.spki }] });
    expect(verifyKeysDoc(byId.b, byId.sig, { pinned, now: NOW })).toEqual({ ok: false, code: 'conflicts_with_pinned' });
    const byKey = signed({ keys: [{ id: 'innocent-name', spki: prod.spki }] });
    expect(verifyKeysDoc(byKey.b, byKey.sig, { pinned, now: NOW })).toEqual({ ok: false, code: 'conflicts_with_pinned' });
    const fine = signed({ keys: [{ id: 'rel-next', spki: makeKey('y').pinned.spki }] });
    expect(verifyKeysDoc(fine.b, fine.sig, { pinned, now: NOW }).ok).toBe(true);
    void KEYS_DOMAIN;
  });
});
