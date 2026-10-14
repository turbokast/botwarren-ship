#!/usr/bin/env node
/**
 * Signs a release manifest (Ed25519, detached). A HUMAN runs this, on a trusted machine, with the release key. CI never
 * has the key (it builds and publishes unsigned artifacts; the signature is what makes them installable). Until the production
 * key exists, releases are published without a manifest at all (see docs/RELEASING.md).
 *
 *   node scripts/release-sign.mjs --key <private-key.pem> --key-id <id> <manifest.json>      writes <manifest.json>.sig
 *   node scripts/release-sign.mjs --verify --manifest <file> --sig <file> --pub <spki-base64> [--id <id>]
 *
 * --key is a PKCS#8 PEM file (a DEV key kept outside the repository, mode 0600). The PRODUCTION key is a non-exportable
 * cloud-KMS key used only by the gated release workflow (docs/RELEASING.md); this script is for dev keys and rehearsals.
 * Refuses a key file readable by group/others, and refuses a key path inside the repository.
 * Before writing the signature it re-verifies it against the public key derived from the private key, and parses the manifest
 * with the same schema the client uses, so a manifest the client would reject is never signed.
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manifest } from '../src/update/manifest.ts';
import { signManifestBytes, verifyManifest } from '../src/update/verify.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (args.includes('--verify')) {
  const bytes = readFileSync(opt('--manifest')); const sig = readFileSync(opt('--sig'), 'utf8');
  const r = verifyManifest(bytes, sig, { keys: [{ id: opt('--id') ?? JSON.parse(sig).keyId, spki: opt('--pub'), dev: false }], now: new Date(), highestSeen: 0 });
  if (!r.ok) { console.error(`verification FAILED (${r.code})`); process.exit(1); }
  console.log(`ok: signed by ${r.keyId}, manifest ${r.manifest.manifestVersion}, stable ${r.manifest.channels.stable}`);
  process.exit(0);
}

const keyPath = opt('--key'); const keyId = opt('--key-id');
const file = args.filter((a, i) => !a.startsWith('--') && !['--key', '--key-id'].includes(args[i - 1]))[0];
if (!keyPath || !keyId || !file) { console.error('usage: release-sign.mjs --key <pem> --key-id <id> <manifest.json>'); process.exit(2); }
const key = resolve(keyPath);
if (key === repoRoot || key.startsWith(repoRoot + sep)) { console.error('refusing: the key path is inside the repository'); process.exit(2); }
if (process.platform !== 'win32' && (statSync(key).mode & 0o077) !== 0) { console.error(`refusing: ${key} is readable by others (chmod 600)`); process.exit(2); }

const bytes = readFileSync(file);
try { Manifest.parse(JSON.parse(bytes.toString('utf8'))); } catch (e) { console.error(`refusing: the manifest does not match the schema the client enforces (${e.message.slice(0, 200)})`); process.exit(2); }
const pem = readFileSync(key);
const sig = signManifestBytes(bytes, pem, keyId);
const spki = createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
const check = verifyManifest(bytes, sig, { keys: [{ id: keyId, spki, dev: true }], now: new Date(), allowDev: true, highestSeen: 0 });
if (!check.ok && check.code !== 'expired') { console.error(`internal error: the fresh signature does not verify (${check.code})`); process.exit(1); }
writeFileSync(`${file}.sig`, sig);
console.log(`signed ${file} with key "${keyId}" -> ${file}.sig`);
console.log(`public key (SPKI, base64) to pin in src/update/keys.ts: ${spki}`);
