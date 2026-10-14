import { describe, expect, it } from 'vitest';
import { verifyManifest, signManifestBytes } from '../../src/update/verify.ts';
import { PINNED_PUBLIC_KEYS } from '../../src/update/keys.ts';
import { NOW, makeKey, makeManifest, sign } from './kit.ts';

const key = makeKey('k1');
const other = makeKey('k2');
const base = () => makeManifest({ stable: '0.5.0', releases: [{ version: '0.5.0' }] }).manifest;
const opts = (extra: Partial<Parameters<typeof verifyManifest>[2]> = {}) => ({ keys: [key.pinned], now: NOW, highestSeen: 0, ...extra });

describe('manifest verification', () => {
  it('accepts a correctly signed, unexpired manifest', () => {
    const { bytes, sig } = sign(base(), key);
    const r = verifyManifest(bytes, sig, opts());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.channels.stable).toBe('0.5.0');
  });

  it('rejects a bad signature: one flipped byte in the manifest', () => {
    const { bytes, sig } = sign(base(), key);
    const t = Buffer.from(bytes); t[t.indexOf(Buffer.from('0.5.0'))] = 0x31; // 1.5.0
    expect(verifyManifest(t, sig, opts())).toEqual({ ok: false, code: 'bad_signature' });
  });

  it('rejects a signature made by a different key, an unknown key id, and a mangled signature file', () => {
    const { bytes } = sign(base(), key);
    const wrong = signManifestBytes(bytes, other.pem, 'k1'); // claims to be k1 but signed by k2
    expect(verifyManifest(bytes, wrong, opts())).toEqual({ ok: false, code: 'bad_signature' });
    expect(verifyManifest(bytes, signManifestBytes(bytes, other.pem, 'k2'), opts())).toEqual({ ok: false, code: 'unknown_key' });
    expect(verifyManifest(bytes, '{"alg":"rsa","keyId":"k1","sig":"x"}', opts())).toEqual({ ok: false, code: 'bad_signature_file' });
    expect(verifyManifest(bytes, 'garbage', opts())).toEqual({ ok: false, code: 'bad_signature_file' });
  });

  it('domain separation: a signature over the bare bytes (no domain prefix) is not a manifest signature', async () => {
    const { sign: edSign } = await import('node:crypto');
    const { createPrivateKey } = await import('node:crypto');
    const bytes = Buffer.from(JSON.stringify(base()));
    const raw = edSign(null, bytes, createPrivateKey(key.pem)).toString('base64');
    expect(verifyManifest(bytes, JSON.stringify({ alg: 'ed25519', keyId: 'k1', sig: raw }), opts())).toEqual({ ok: false, code: 'bad_signature' });
  });

  it('rejects an expired manifest (signed correctly) and does nothing else with it', () => {
    const m = makeManifest({ stable: '0.5.0', expires: '2026-10-14T11:59:59.000Z', releases: [{ version: '0.5.0' }] }).manifest;
    const { bytes, sig } = sign(m, key);
    expect(verifyManifest(bytes, sig, opts())).toEqual({ ok: false, code: 'expired' });
  });

  it('rollback / freeze protection: a manifest older than the highest ever accepted is refused; equal is fine', () => {
    const old = makeManifest({ manifestVersion: 6, stable: '0.5.0', releases: [{ version: '0.5.0' }] }).manifest;
    const { bytes, sig } = sign(old, key);
    expect(verifyManifest(bytes, sig, opts({ highestSeen: 7 }))).toEqual({ ok: false, code: 'rollback' });
    expect(verifyManifest(bytes, sig, opts({ highestSeen: 6 })).ok).toBe(true);
  });

  it('a validly signed but malformed manifest is refused; unsigned content is never parsed', () => {
    const { bytes, sig } = sign({ schema: 1, hello: 'world' }, key);
    expect(verifyManifest(bytes, sig, opts())).toEqual({ ok: false, code: 'malformed' });
    // wrong version strings (prerelease) are rejected by the schema
    const m = base(); (m.channels as { stable: string }).stable = '0.5.0-evil';
    const s2 = sign(m, key);
    expect(verifyManifest(s2.bytes, s2.sig, opts()).ok).toBe(false);
  });

  it('dev keys are refused unless explicitly allowed; expired keys are refused', () => {
    const dev = makeKey('devk', true);
    const { bytes, sig } = sign(base(), dev);
    expect(verifyManifest(bytes, sig, { keys: [dev.pinned], now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'dev_key_refused' });
    expect(verifyManifest(bytes, sig, { keys: [dev.pinned], now: NOW, highestSeen: 0, allowDev: true }).ok).toBe(true);
    const old = { ...key.pinned, notAfter: '2026-01-01T00:00:00Z' };
    const s = sign(base(), key);
    expect(verifyManifest(s.bytes, s.sig, { keys: [old], now: NOW, highestSeen: 0 })).toEqual({ ok: false, code: 'key_expired' });
  });

  it('rotation: any key in the pinned list may sign', () => {
    const { bytes, sig } = sign(base(), other);
    expect(verifyManifest(bytes, sig, opts({ keys: [key.pinned, other.pinned] })).ok).toBe(true);
  });

  it('refuses oversized manifests', () => {
    expect(verifyManifest(Buffer.alloc(2 * 1024 * 1024), '{}', opts())).toEqual({ ok: false, code: 'too_large' });
  });

  it('the embedded key list is well-formed (SPKI Ed25519); dev keys stay flagged and are never the only trust anchor', () => {
    expect(PINNED_PUBLIC_KEYS.length).toBeGreaterThan(0);
    for (const k of PINNED_PUBLIC_KEYS) expect(Buffer.from(k.spki, 'base64')).toHaveLength(44);
    expect(PINNED_PUBLIC_KEYS.filter((k) => k.dev).every((k) => k.id.startsWith('dev-'))).toBe(true);
    expect(PINNED_PUBLIC_KEYS.some((k) => !k.dev)).toBe(true); // production keys are pinned (details: trust.test.ts)
  });

});
