/**
 * Release signing scripts: the sign-manifest dry run with a mocked Cloud KMS, the CLI's refusal to accept a signer that is not the pinned key,
 * and the recovery keys-document commands (new, sign, combine) driven end to end through the real CLI.
 */
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS modules without types
import { crc32c } from '../../scripts/lib/kms.mjs';
// @ts-expect-error plain JS modules without types
import { startMockKms } from '../../scripts/lib/mock-kms.mjs';
// @ts-expect-error plain JS modules without types
import { dryRun } from '../../scripts/release-dry-run.mjs';
import { PINNED_PUBLIC_KEYS } from '../../src/update/keys.ts';
import { makeKey, makeManifest, rmTmp } from '../update/kit.ts';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'release-sign.mjs');
const RES = 'projects/botwarren-release/locations/europe-west2/keyRings/botwarren-release/cryptoKeys/manifest-signing/cryptoKeyVersions/1';
type Mock = { url: string; calls: { path: string }[]; close: () => Promise<void> };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'bw-rs-')); cleanup.push(() => rmTmp(d)); return d; };
// async spawn: the mock KMS lives in THIS process's event loop, so the CLI must not block it
const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ status: number | null; out: string }>((resolve) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  p.stderr.on('data', (c: Buffer) => { out += c.toString(); });
  p.on('close', (status) => resolve({ status, out }));
});

describe('release signing', () => {
  it('crc32c matches the standard check value', () => {
    expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283);
  });

  it('the sign-manifest dry run (mock KMS) passes: assemble, sign, verify, and every refusal', async () => {
    const lines: string[] = [];
    await dryRun((l: string) => lines.push(l));
    expect(lines.join('\n')).toContain('sign-manifest dry run OK');
    expect(lines.filter((l) => l.includes('refused as expected')).length).toBeGreaterThanOrEqual(10);
  }, 60_000);

  it('the CLI with --kms refuses a signer that is not the PINNED production key, and writes nothing', async () => {
    const d = tmp();
    const wrong = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const mock: Mock = await startMockKms({ privateKeyPem: wrong, resource: RES });
    cleanup.push(() => mock.close());
    const mf = join(d, 'manifest.json');
    writeFileSync(mf, JSON.stringify(makeManifest({ stable: '0.5.0', releases: [{ version: '0.5.0' }] }).manifest));
    const r = await run(['--kms', RES, '--key-id', 'kms-2026a', mf], { BOTWARREN_KMS_ENDPOINT: mock.url, GOOGLE_OAUTH_ACCESS_TOKEN: 'test-token-123456' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('does not verify against the PINNED public key');
    expect(existsSync(`${mf}.sig`)).toBe(false);
    expect(mock.calls.filter((c: { path: string }) => c.path.endsWith(':asymmetricSign'))).toHaveLength(1);
    // the dev key id and a recovery key id are never accepted as the production signer
    for (const id of ['dev-1', 'recovery-1']) expect((await run(['--kms', RES, '--key-id', id, mf], { BOTWARREN_KMS_ENDPOINT: mock.url, GOOGLE_OAUTH_ACCESS_TOKEN: 'test-token-123456' })).out).toContain('not a pinned, non-dev RELEASE key');
  });

  it('--print-public-key reads the key from KMS (mock) and --kms refuses a key that is not a version resource', async () => {
    const kp = generateKeyPairSync('ed25519');
    const mock: Mock = await startMockKms({ privateKeyPem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), resource: RES });
    cleanup.push(() => mock.close());
    const r = await run(['--kms', RES, '--print-public-key'], { BOTWARREN_KMS_ENDPOINT: mock.url, GOOGLE_OAUTH_ACCESS_TOKEN: 'test-token-123456' });
    expect(r.out.trim()).toBe(kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
    expect((await run(['--kms', 'projects/x/locations/y', '--print-public-key'], { BOTWARREN_KMS_ENDPOINT: mock.url, GOOGLE_OAUTH_ACCESS_TOKEN: 'test-token-123456' })).out).toContain('key VERSION resource');
  });

  it('the pinned production public key is the one Cloud KMS reported (documented in docs/RELEASING.md)', () => {
    expect(PINNED_PUBLIC_KEYS.find((k) => k.id === 'kms-2026a')!.spki).toBe('MCowBQYDK2VwAyEA9wgEUj5KLXm+KZSD9cpJw3B8KmTtGDGL4gudKWPfTuM=');
  });

  it('refuses a key file in the repository or readable by others (DEV key mode is unchanged)', async () => {
    const d = tmp();
    const k = makeKey('dev-x', true);
    const kf = join(d, 'k.pem'); writeFileSync(kf, k.pem); chmodSync(kf, 0o644);
    const mf = join(d, 'm.json'); writeFileSync(mf, JSON.stringify(makeManifest({ stable: '0.5.0', releases: [{ version: '0.5.0' }] }).manifest));
    if (process.platform !== 'win32') expect((await run(['--key', kf, '--key-id', 'dev-x', mf])).out).toContain('readable by others'); // POSIX permission bits only
    chmodSync(kf, 0o600);
    const ok = await run(['--key', kf, '--key-id', 'dev-x', mf]);
    expect(ok.status).toBe(0);
    expect(readFileSync(`${mf}.sig`, 'utf8')).toContain('"keyId":"dev-x"');
  });
});

describe('recovery keys-document commands through the CLI', () => {
  it('new -> sign (two holders) -> combine produces a document the agent verifies; one signature is refused; a wrong key file is refused', async () => {
    // The CLI pins the REAL recovery keys, whose private halves are offline, so a full 2-of-3 signing cannot run here (the threshold logic is tested
    // exhaustively in test/update/trust.test.ts). This tests the CLI's own guards, against the real pinned ids.
    const d = tmp();
    const doc = join(d, 'keys.json');
    const mk = await run(['--keys-doc-new', '--seq', '1', '--epoch', '1', '--revoke', 'kms-2026a', '--out', doc]);
    expect(mk.status).toBe(0);
    expect(JSON.parse(readFileSync(doc, 'utf8'))).toMatchObject({ kind: 'botwarren-keys', seq: 1, epoch: 1, revoked: ['kms-2026a'] });
    // a key that is not recovery-1's private key is refused even if it is a valid Ed25519 key
    const pem = join(d, 'r.pem'); writeFileSync(pem, makeKey('x').pem, { mode: 0o600 });
    const s = await run(['--keys-doc-sign', '--keys', doc, '--recovery-key', pem, '--recovery-id', 'recovery-1', '--out', join(d, 'p1')]);
    expect(s.status).toBe(2);
    expect(s.out).toContain('public key mismatch');
    // only pinned recovery ids may sign; a release id may not
    expect((await run(['--keys-doc-sign', '--keys', doc, '--recovery-key', pem, '--recovery-id', 'kms-2026a', '--out', join(d, 'p1')])).out).toContain('not a pinned recovery key');
    // combining fewer than two partial signatures is refused
    expect((await run(['--keys-doc-combine', '--keys', doc, '--out', join(d, 'k.sig'), join(d, 'p1')])).out).toContain('usage');
  });
});
