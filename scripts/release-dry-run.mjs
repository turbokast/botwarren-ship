#!/usr/bin/env node
/**
 * Dry run of the release workflow's sign-manifest job with a MOCKED signer: no cloud account, no credentials, no network.
 *
 *   node scripts/release-dry-run.mjs
 *
 * It fabricates a build output (a real bundle zip, six placeholder archives, SHA256SUMS), runs the real `assemble-manifest.mjs` on it, signs the
 * manifest through the real `signManifestKms` against a loopback mock of Cloud KMS (a throwaway key pinned for this run only), verifies the result
 * with the agent's own verifier, and checks the failure modes: a tampered manifest, a tampered signature, a wrong or unpinned key id, a bad
 * request checksum, an oversize manifest and a missing token all stop the release. CI runs this on every push (.github/workflows/ci.yml).
 */
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../src/update/archive.ts';
import { MAX_SIGNABLE_MANIFEST_BYTES } from '../src/update/manifest.ts';
import { verifyManifest } from '../src/update/verify.ts';
import { signManifestKms } from './lib/kms.mjs';
import { startMockKms } from './lib/mock-kms.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RESOURCE = 'projects/botwarren-dryrun/locations/europe-west2/keyRings/botwarren-release/cryptoKeys/manifest-signing/cryptoKeyVersions/1';
const VERSION = '9.9.9';
const TARGETS = ['win-x64', 'win-arm64', 'mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64'];
const sha = (b) => createHash('sha256').update(b).digest('hex');

export async function dryRun(log = console.log) {
  const work = mkdtempSync(join(tmpdir(), 'bw-sign-dryrun-'));
  const kp = generateKeyPairSync('ed25519');
  const pem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spki = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pinned = [{ id: 'kms-dryrun', spki, dev: false, role: 'release' }];
  const mock = await startMockKms({ privateKeyPem: pem, resource: RESOURCE });
  const env = { BOTWARREN_KMS_ENDPOINT: mock.url };
  const expectFail = async (label, p, re) => {
    try { await p; } catch (e) { if (re.test(e.message)) { log(`  refused as expected: ${label}`); return; } throw new Error(`${label}: failed with the wrong error: ${e.message}`, { cause: e }); }
    throw new Error(`${label}: was NOT refused`);
  };
  try {
    // 1. a fabricated build output
    const dist = join(work, 'dist'); mkdirSync(dist);
    const files = new Map();
    files.set(`bundle-${VERSION}.zip`, writeZip([['agent.mjs', '//'], ['cli.mjs', '//'], ['ops.html', '<p>'], ['VERSION', `${VERSION}\n`]].map(([name, data]) => ({ name, data: Buffer.from(data), mode: 0o644 }))));
    for (const t of TARGETS) files.set(`botwarren-${VERSION}-${t}.${t.startsWith('win-') ? 'zip' : 'tar.gz'}`, Buffer.from(`placeholder archive ${t}`));
    for (const [n, d] of files) writeFileSync(join(dist, n), d);
    writeFileSync(join(dist, 'SHA256SUMS'), [...files].map(([n, d]) => `${sha(d)}  ${n}`).sort().join('\n') + '\n');

    // 2. assemble (the workflow's step, run exactly as the workflow runs it)
    const out = join(work, 'out'); mkdirSync(out);
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(here, 'assemble-manifest.mjs'), '--dir', dist, '--version', VERSION, '--out', out, '--commit', 'abcdef1234567', '--expires-days', '30'], { stdio: 'inherit' });
    const bytes = readFileSync(join(out, 'manifest.json'));
    if (readFileSync(join(out, 'install-index.txt'), 'utf8').trim().split('\n').length !== TARGETS.length) throw new Error('install-index.txt does not list every platform');

    // 3. sign with the mock KMS and verify with the agent's own verifier
    const sigText = await signManifestKms({ bytes, resource: RESOURCE, keyId: 'kms-dryrun', pinned, token: 'dry-run-token', env });
    writeFileSync(join(out, 'manifest.json.sig'), sigText);
    const v = verifyManifest(bytes, sigText, { keys: pinned, now: new Date(), highestSeen: 0 });
    if (!v.ok || v.manifest.channels.stable !== VERSION || Object.keys(v.manifest.releases[VERSION].full).length !== TARGETS.length) throw new Error(`the signed manifest does not verify (${v.ok ? 'content' : v.code})`);
    log(`  signed and verified: manifest ${v.manifest.manifestVersion}, epoch ${v.manifest.epoch}, key ${v.keyId}; mock KMS saw ${mock.calls.length} call(s)`);
    if (mock.calls.length !== 1) throw new Error('expected exactly one signing call');

    // 4. what must stop a release
    const t = Buffer.from(bytes); t[t.indexOf(Buffer.from(VERSION))] = 0x38;
    const tv = verifyManifest(t, sigText, { keys: pinned, now: new Date(), highestSeen: 0 });
    if (tv.ok || tv.code !== 'bad_signature') throw new Error('a tampered manifest was accepted');
    log('  refused as expected: a tampered manifest');
    const sign = (o) => signManifestKms({ bytes, resource: RESOURCE, keyId: 'kms-dryrun', pinned, token: 'dry-run-token', env, ...o });
    await expectFail('a key id that is not pinned', sign({ keyId: 'kms-other' }), /not a pinned, non-dev RELEASE key/);
    await expectFail('a dev key id', sign({ pinned: [{ ...pinned[0], dev: true }] }), /not a pinned, non-dev RELEASE key/);
    await expectFail('a recovery key as the signer', sign({ pinned: [{ ...pinned[0], role: 'recovery' }] }), /not a pinned, non-dev RELEASE key/);
    await expectFail('a different pinned public key (wrong signer)', sign({ pinned: [{ ...pinned[0], spki: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }] }), /does not verify against the PINNED public key/);
    await expectFail('an oversize manifest', sign({ bytes: Buffer.alloc(MAX_SIGNABLE_MANIFEST_BYTES + 1, 0x20) }), /signs at most/);
    await expectFail('a malformed manifest', sign({ bytes: Buffer.from('{"schema":1}') }), /schema/);
    await expectFail('a missing token', sign({ token: '' }), /HTTP 401/);
    const bad = await startMockKms({ privateKeyPem: pem, resource: RESOURCE, tamperSignature: true });
    await expectFail('a corrupted signature from the signer', sign({ env: { BOTWARREN_KMS_ENDPOINT: bad.url } }), /does not verify against the PINNED public key/);
    await bad.close();
    const crc = await startMockKms({ privateKeyPem: pem, resource: RESOURCE, wrongCrc: true });
    await expectFail('a request checksum the service did not confirm', sign({ env: { BOTWARREN_KMS_ENDPOINT: crc.url } }), /did not confirm the request checksum/);
    await crc.close();
    await expectFail('a non-loopback http endpoint', sign({ env: { BOTWARREN_KMS_ENDPOINT: 'http://example.com' } }), /must be https/);
    await expectFail('a key ring that is not a key version resource', sign({ resource: 'projects/x/locations/y' }), /key VERSION resource/);
    log('sign-manifest dry run OK');
    return { ok: true };
  } finally { await mock.close(); rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  dryRun().catch((e) => { console.error(`release dry run FAILED: ${e.message}`); process.exit(1); });
}
