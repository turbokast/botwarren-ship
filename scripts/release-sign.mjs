#!/usr/bin/env node
/**
 * Signs release documents. Ed25519, detached, over exact bytes, domain-separated (see src/update/verify.ts and trust.ts).
 *
 * MANIFEST (routine releases, the production RELEASE key):
 *   node scripts/release-sign.mjs --kms <key version resource> --key-id kms-2026a <manifest.json>        writes <manifest.json>.sig
 *   node scripts/release-sign.mjs --kms <resource> --print-public-key                                     prints the SPKI (base64) to compare with keys.ts
 *   node scripts/release-sign.mjs --key <private-key.pem> --key-id <id> <manifest.json>                  DEV key file (tests, rehearsals)
 *   node scripts/release-sign.mjs --verify --manifest <file> --sig <file> --pub <spki-base64> [--id <id>]
 *
 *   --kms signs with a non-exportable Google Cloud KMS key. The workflow's sign-manifest job uses it with the federated access token
 *   (GOOGLE_OAUTH_ACCESS_TOKEN); the owner's EMERGENCY local run uses `gcloud auth login` (an account holding roles/cloudkms.signerVerifier on
 *   the key). Every call is logged by Cloud Audit Logs and e-mailed to the owner. In every mode the signature is re-verified against the PINNED
 *   public key (src/update/keys.ts) before a file is written, and the manifest is parsed with the client's own schema first, so a manifest
 *   the agent would refuse, or one the key must not sign, is never signed. The production key id must be a pinned, non-dev release key.
 *
 * KEYS DOCUMENT (recovery: rotate/revoke the release key, raise the epoch; any 2 of the 3 offline recovery keys):
 *   node scripts/release-sign.mjs --keys-doc-new --seq <n> --epoch <e> [--add <id>=<spki>]... [--revoke <id>]... --out keys.json
 *   node scripts/release-sign.mjs --keys-doc-sign --keys keys.json --recovery-key <pem> --recovery-id recovery-1 --out keys.json.recovery-1
 *   node scripts/release-sign.mjs --keys-doc-combine --keys keys.json --out keys.json.sig <partial> <partial>
 *   (the private recovery key is an age file: decrypt it to a 0600 file outside the repository for the moment of signing, e.g.
 *    `age -d recovery-1.age > /dev/shm/r1.pem`, or use scripts/recovery-sign.mjs in the private repository, which never writes it to disk.)
 *
 * Refuses a key file readable by group/others, and a key path inside the repository.
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_PUBLIC_KEYS, roleOf } from '../src/update/keys.ts';
import { MAX_SIGNABLE_MANIFEST_BYTES, Manifest } from '../src/update/manifest.ts';
import { signManifestBytes, verifyManifest } from '../src/update/verify.ts';
import { KeysDoc, keysSigFile, signKeysDocBytes, verifyKeysDoc } from '../src/update/trust.ts';
import { accessToken, kmsPublicKeySpki, signManifestKms } from './lib/kms.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const optAll = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const fail = (m, code = 2) => { console.error(m); process.exit(code); };
const VALUE_FLAGS = ['--key', '--key-id', '--kms', '--manifest', '--sig', '--pub', '--id', '--seq', '--epoch', '--add', '--revoke', '--out', '--keys', '--recovery-key', '--recovery-id'];
const positional = () => args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));

function checkKeyFile(p) {
  const key = resolve(p);
  if (key === repoRoot || key.startsWith(repoRoot + sep)) fail('refusing: the key path is inside the repository');
  if (process.platform !== 'win32' && (statSync(key).mode & 0o077) !== 0) fail(`refusing: ${key} is readable by others (chmod 600)`);
  return key;
}

// ---- verify a signed manifest against an explicit public key
if (args.includes('--verify')) {
  const bytes = readFileSync(opt('--manifest')); const sig = readFileSync(opt('--sig'), 'utf8');
  const r = verifyManifest(bytes, sig, { keys: [{ id: opt('--id') ?? JSON.parse(sig).keyId, spki: opt('--pub'), dev: false }], now: new Date(), highestSeen: 0, epoch: Number(opt('--epoch') ?? 1) });
  if (!r.ok) { console.error(`verification FAILED (${r.code})`); process.exit(1); }
  console.log(`ok: signed by ${r.keyId}, manifest ${r.manifest.manifestVersion}, epoch ${r.manifest.epoch}, stable ${r.manifest.channels.stable}`);
  process.exit(0);
}

// ---- keys document: create
if (args.includes('--keys-doc-new')) {
  const out = opt('--out'); const seq = Number(opt('--seq')); const epoch = Number(opt('--epoch'));
  if (!out || !Number.isInteger(seq) || !Number.isInteger(epoch)) fail('usage: --keys-doc-new --seq <n> --epoch <e> [--add <id>=<spki>]... [--revoke <id>]... --out keys.json');
  const keys = optAll('--add').map((a) => { const [id, spki] = a.split('='); return { id, spki }; });
  const doc = { schema: 1, kind: 'botwarren-keys', seq, epoch, issued: new Date().toISOString(), keys, revoked: optAll('--revoke') };
  KeysDoc.parse(doc);
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${out} (seq ${seq}, epoch ${epoch}, ${keys.length} release key(s), ${doc.revoked.length} revoked). Next: two recovery holders run --keys-doc-sign, then --keys-doc-combine.`);
  process.exit(0);
}

// ---- keys document: one recovery signature (partial)
if (args.includes('--keys-doc-sign')) {
  const keysFile = opt('--keys'); const rk = opt('--recovery-key'); const rid = opt('--recovery-id'); const out = opt('--out');
  if (!keysFile || !rk || !rid || !out) fail('usage: --keys-doc-sign --keys keys.json --recovery-key <pem> --recovery-id <recovery-N> --out <partial>');
  const bytes = readFileSync(keysFile);
  try { KeysDoc.parse(JSON.parse(bytes.toString('utf8'))); } catch (e) { fail(`refusing: not a valid keys document (${String(e.message).slice(0, 160)})`); }
  const pinned = PINNED_PUBLIC_KEYS.find((k) => k.id === rid && roleOf(k) === 'recovery');
  if (!pinned) fail(`refusing: ${rid} is not a pinned recovery key`);
  const pem = readFileSync(checkKeyFile(rk));
  if (createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64') !== pinned.spki) fail(`refusing: that private key is not ${rid}'s (public key mismatch)`);
  writeFileSync(out, JSON.stringify(signKeysDocBytes(bytes, pem, rid)) + '\n');
  console.log(`${rid} signed ${keysFile} -> ${out}. Print nothing else; delete any decrypted copy of the key now.`);
  process.exit(0);
}

// ---- keys document: combine partial signatures, enforce the threshold, write keys.json.sig
if (args.includes('--keys-doc-combine')) {
  const keysFile = opt('--keys'); const out = opt('--out'); const parts = positional();
  if (!keysFile || !out || parts.length < 2) fail('usage: --keys-doc-combine --keys keys.json --out keys.json.sig <partial> <partial> [...]');
  const sigText = keysSigFile(parts.map((p) => JSON.parse(readFileSync(p, 'utf8'))));
  const v = verifyKeysDoc(readFileSync(keysFile), sigText, { pinned: PINNED_PUBLIC_KEYS, now: new Date() });
  if (!v.ok) fail(`refusing: the combined signatures do not verify (${v.code})`, 1);
  writeFileSync(out, sigText);
  console.log(`wrote ${out}: keys document seq ${v.doc.seq}, epoch ${v.doc.epoch}, signed by ${v.signers.join(' + ')}. Publish keys.json and keys.json.sig to the downloads host (bucket root).`);
  process.exit(0);
}

// ---- print the public key of a KMS key version
if (args.includes('--print-public-key')) {
  const resource = opt('--kms'); if (!resource) fail('usage: --print-public-key --kms <key version resource>');
  console.log(await kmsPublicKeySpki({ resource, token: accessToken() }));
  process.exit(0);
}

// ---- sign a manifest (KMS key, or a DEV key file)
const keyPath = opt('--key'); const kms = opt('--kms'); const keyId = opt('--key-id');
const file = positional()[0];
if ((!keyPath && !kms) || (keyPath && kms) || !keyId || !file) fail('usage: release-sign.mjs (--kms <key version resource> | --key <pem>) --key-id <id> <manifest.json>');

const bytes = readFileSync(file);
let sigText; let derivedSpki;
if (kms) {
  try { sigText = await signManifestKms({ bytes, resource: kms, keyId, pinned: PINNED_PUBLIC_KEYS, token: accessToken() }); } catch (e) { fail(`refusing: ${e.message}`, 1); }
} else {
  if (bytes.length > MAX_SIGNABLE_MANIFEST_BYTES) fail(`refusing: the manifest is ${bytes.length} bytes; over the ${MAX_SIGNABLE_MANIFEST_BYTES} the production key can sign`);
  let parsed;
  try { parsed = Manifest.parse(JSON.parse(bytes.toString('utf8'))); } catch (e) { fail(`refusing: the manifest does not match the schema the client enforces (${String(e.message).slice(0, 200)})`); }
  const pem = readFileSync(checkKeyFile(keyPath));
  sigText = signManifestBytes(bytes, pem, keyId);
  derivedSpki = createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
  const check = verifyManifest(bytes, sigText, { keys: [{ id: keyId, spki: derivedSpki, dev: true }], now: new Date(), allowDev: true, highestSeen: 0, epoch: parsed.epoch });
  if (!check.ok && check.code !== 'expired') { console.error(`internal error: the fresh signature does not verify (${check.code}); nothing written`); process.exit(1); }
}
writeFileSync(`${file}.sig`, sigText);
console.log(`signed ${file} with key "${keyId}" (${kms ? 'Cloud KMS, verified against the pinned public key' : 'key file'}) -> ${file}.sig`);
if (derivedSpki) console.log(`public key (SPKI, base64) to pin in src/update/keys.ts: ${derivedSpki}`);
