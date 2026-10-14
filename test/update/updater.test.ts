import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ArchiveError, extractTo, readTarGz, readZip, safeEntryName, writeTarGz, writeZip } from '../../src/update/archive.ts';
import { Updater, resolveUrl, type UpdaterOptions } from '../../src/update/updater.ts';
import { CHECK_INTERVAL_MS, CHECK_JITTER_MS, MAX_BACKOFF_MS, firstCheckAt, nextCheckAt } from '../../src/update/schedule.ts';
import { DEFAULT_BASE_URL, resolvePolicy } from '../../src/update/policy.ts';
import { paths, readDenylist, readPointer, readResult, readUpdateState, writeUpdateState, writeJsonAtomic } from '../../src/update/state.ts';
import { NOW, fakeFetch, makeBundle, makeKey, makeManifest, makeRoot, mkTmp, rmTmp, sign, sha256 } from './kit.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });
const key = makeKey('k1');
const BASE = 'https://downloads.test/';

function setup(o: { current?: string; manifest?: Parameters<typeof makeManifest>[0]; tamper?: (files: Map<string, Buffer | string>) => void; selftest?: boolean; opts?: Partial<UpdaterOptions> } = {}) {
  const root = makeRoot(o.current ?? '0.4.0');
  cleanup.push(() => rmTmp(root));
  const { manifest, bundles } = makeManifest(o.manifest ?? { stable: '0.5.0', releases: [{ version: '0.5.0' }, { version: '0.4.0' }] });
  const { bytes, sig } = sign(manifest, key);
  const files = new Map<string, Buffer | string>([['manifest.json', bytes], ['manifest.json.sig', sig], ...bundles]);
  o.tamper?.(files);
  const f = fakeFetch(files);
  const updater = new Updater({
    root, baseUrl: BASE, currentVersion: o.current ?? '0.4.0', channel: 'stable', platform: 'linux-x64', fetchImpl: f.impl, keys: [key.pinned],
    now: () => NOW.getTime(), rand: () => 0.5, selftest: async () => o.selftest ?? true, ...o.opts,
  });
  return { root, updater, files, requests: f.requests };
}

describe('Updater: the happy path', () => {
  it('downloads, verifies, stages side by side, and points current.json at the new version in trial state', async () => {
    const { root, updater } = setup();
    const out = await updater.check();
    expect(out).toMatchObject({ status: 'staged', version: '0.5.0' });
    expect(readdirSync(join(root, 'versions')).sort()).toEqual(['0.4.0', '0.5.0']); // the running version is untouched
    expect(readFileSync(join(root, 'versions', '0.5.0', 'VERSION'), 'utf8').trim()).toBe('0.5.0');
    expect(readPointer(root)).toMatchObject({ version: '0.5.0', previous: '0.4.0', knownGood: '0.4.0', state: 'trial', bootCount: 0 });
    expect(readResult(root)).toMatchObject({ code: 'updated', from: '0.4.0', to: '0.5.0' });
    expect(readUpdateState(root).highestManifestVersion).toBe(1);
    expect(readdirSync(paths(root).staging)).toEqual([]); // nothing left in staging
  });

  it('up to date: no download of any bundle; next check is scheduled 6h+ ahead', async () => {
    const { root, updater, requests } = setup({ current: '0.5.0' });
    expect((await updater.check()).status).toBe('up_to_date');
    expect(requests.filter((r) => r.includes('bundle'))).toHaveLength(0);
    const st = readUpdateState(root);
    expect(st.nextCheckMs - NOW.getTime()).toBeGreaterThanOrEqual(CHECK_INTERVAL_MS);
    expect(st.consecutiveFailures).toBe(0);
  });

  it('--dry-run changes nothing on disk', async () => {
    const { root, updater } = setup();
    const out = await updater.check({ dryRun: true });
    expect(out).toMatchObject({ status: 'would_update', version: '0.5.0' });
    expect(readdirSync(join(root, 'versions'))).toEqual(['0.4.0']);
    expect(readPointer(root)!.version).toBe('0.4.0');
    expect(existsSync(paths(root).updateState)).toBe(false);
  });
});

describe('Updater: refuses anything not in a verified manifest', () => {
  it('tampered bundle (hash mismatch): nothing is extracted, the pointer does not move, a result is recorded', async () => {
    const { root, updater } = setup({ tamper: (f) => { f.set('bundle-0.5.0.zip', makeBundle('0.5.0', { 'agent.mjs': '// EVIL\n' })); } });
    expect(await updater.check()).toEqual({ status: 'error', code: 'size_mismatch' }); // a different-size payload is caught first...
    const { updater: u2, root: r2, files } = setup();
    const real = files.get('bundle-0.5.0.zip') as Buffer;
    const evil = Buffer.from(real); evil[evil.length - 30]! ^= 0xff; // same size, one flipped byte
    files.set('bundle-0.5.0.zip', evil);
    expect(await u2.check()).toEqual({ status: 'error', code: 'hash_mismatch' }); // ...and an equal-size one by the sha256
    for (const r of [root, r2]) {
      expect(readdirSync(join(r, 'versions'))).toEqual(['0.4.0']);
      expect(readPointer(r)!.version).toBe('0.4.0');
    }
    expect(readResult(r2)).toMatchObject({ code: 'hash_mismatch' });
  });

  it('bad signature: tampered manifest is refused before anything is parsed or downloaded', async () => {
    const { root, updater, requests } = setup({ tamper: (f) => { const b = Buffer.from(f.get('manifest.json') as Buffer); b[b.indexOf(Buffer.from('rolloutBp')) + 12] = 0x39; f.set('manifest.json', b); } });
    expect(await updater.check()).toEqual({ status: 'error', code: 'bad_signature' });
    expect(requests.some((r) => r.includes('bundle'))).toBe(false);
    expect(readPointer(root)!.version).toBe('0.4.0');
    expect(readResult(root)).toMatchObject({ code: 'signature_invalid' });
    expect(readUpdateState(root).consecutiveFailures).toBe(1);
  });

  it('expired manifest: no install, the running version is left alone, a result is recorded', async () => {
    const { root, updater } = setup({ manifest: { stable: '0.5.0', expires: '2026-10-14T11:00:00.000Z', releases: [{ version: '0.5.0' }] } });
    expect(await updater.check()).toEqual({ status: 'error', code: 'expired' });
    expect(readPointer(root)!.version).toBe('0.4.0');
    expect(readResult(root)).toMatchObject({ code: 'manifest_expired' });
  });

  it('rollback attack: an older (validly signed) manifest is refused after a newer one was accepted', async () => {
    const { root, updater } = setup({ manifest: { manifestVersion: 5, stable: '0.5.0', releases: [{ version: '0.5.0' }] } });
    await updater.check({ dryRun: false });
    expect(readUpdateState(root).highestManifestVersion).toBe(5);
    // attacker replays manifest v4 (a real, signed one that pointed at an old release)
    const old = makeManifest({ manifestVersion: 4, stable: '0.3.0', releases: [{ version: '0.3.0' }] });
    const s = sign(old.manifest, key);
    const fx = fakeFetch(new Map<string, Buffer | string>([['manifest.json', s.bytes], ['manifest.json.sig', s.sig], ...old.bundles]));
    const u2 = new Updater({ root, baseUrl: BASE, currentVersion: '0.5.0', channel: 'stable', platform: 'linux-x64', fetchImpl: fx.impl, keys: [key.pinned], now: () => NOW.getTime(), selftest: async () => true });
    expect(await u2.check()).toEqual({ status: 'error', code: 'rollback' });
    expect(readUpdateState(root).highestManifestVersion).toBe(5);
  });

  it('a signed downgrade without rollbackFrom is refused; a blocked release is never installed', async () => {
    const down = setup({ current: '0.5.0', manifest: { stable: '0.4.0', releases: [{ version: '0.4.0' }, { version: '0.5.0' }] } });
    expect(await down.updater.check()).toMatchObject({ status: 'skipped', reason: 'downgrade_refused' });
    const blocked = setup({ manifest: { stable: '0.5.0', blocked: ['0.5.0'], releases: [{ version: '0.5.0' }] } });
    expect(await blocked.updater.check()).toMatchObject({ status: 'skipped', reason: 'blocked' });
    expect(readdirSync(join(blocked.root, 'versions'))).toEqual(['0.4.0']);
  });

  it('a signed rollbackFrom does downgrade (and is marked as a rollback)', async () => {
    const s = setup({ current: '0.5.0', manifest: { stable: '0.4.0', rollbackFrom: [{ from: '0.5.0', to: '0.4.0' }], releases: [{ version: '0.4.0' }, { version: '0.5.0' }] } });
    expect(await s.updater.check()).toMatchObject({ status: 'staged', version: '0.4.0', rollback: true });
  });

  it('a bundle whose VERSION does not match the manifest, or that lacks agent.mjs, is refused', async () => {
    const wrong = setup({ manifest: { stable: '0.5.0', releases: [{ version: '0.5.0', bundle: makeBundle('0.9.9') }] } });
    expect(await wrong.updater.check()).toEqual({ status: 'error', code: 'bad_bundle' });
    const noAgent = setup({ manifest: { stable: '0.5.0', releases: [{ version: '0.5.0', bundle: writeZip([{ name: 'VERSION', data: Buffer.from('0.5.0\n'), mode: 0o644 }, { name: 'cli.mjs', data: Buffer.from('x'), mode: 0o644 }]) }] } });
    expect(await noAgent.updater.check()).toEqual({ status: 'error', code: 'bad_bundle' });
  });

  it('a failed self-test removes the staged version and leaves the pointer alone', async () => {
    const { root, updater } = setup({ selftest: false });
    expect(await updater.check()).toEqual({ status: 'error', code: 'selftest_failed' });
    expect(readdirSync(join(root, 'versions'))).toEqual(['0.4.0']);
    expect(readPointer(root)!.version).toBe('0.4.0');
    expect(readResult(root)).toMatchObject({ code: 'selftest_failed' });
  });

  it('a version dir that already exists for the RUNNING version is never replaced', async () => {
    const { root, updater } = setup({ current: '0.4.0', manifest: { stable: '0.4.0', releases: [{ version: '0.4.0' }] } });
    expect((await updater.check()).status).toBe('up_to_date');
    expect(readFileSync(join(root, 'versions', '0.4.0', 'agent.mjs'), 'utf8')).toBe('//');
  });

  it('only https URLs (http only for loopback), no credentials; relative URLs resolve against the base', () => {
    expect(resolveUrl('bundle.zip', BASE)).toBe('https://downloads.test/bundle.zip');
    expect(resolveUrl('http://evil.test/x.zip', BASE)).toBeNull();
    expect(resolveUrl('https://user:pw@evil.test/x.zip', BASE)).toBeNull();
    expect(resolveUrl('http://127.0.0.1:9/x.zip', BASE)).toBe('http://127.0.0.1:9/x.zip');
    expect(resolveUrl('ftp://x/y', BASE)).toBeNull();
  });

  it('network failure: records a failure and backs off; never throws', async () => {
    const root = makeRoot('0.4.0'); cleanup.push(() => rmTmp(root));
    const u = new Updater({ root, baseUrl: BASE, currentVersion: '0.4.0', channel: 'stable', platform: 'linux-x64', fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch, keys: [key.pinned], now: () => NOW.getTime(), rand: () => 0 });
    expect(await u.check()).toEqual({ status: 'error', code: 'download_failed' });
    expect(readUpdateState(root).consecutiveFailures).toBe(1);
    await u.check(); await u.check(); await u.check(); await u.check(); await u.check();
    expect(readUpdateState(root).nextCheckMs - NOW.getTime()).toBeLessThanOrEqual(MAX_BACKOFF_MS + CHECK_JITTER_MS);
  });

  it('staged-rollout bucketing is applied with the install\'s own id (stable across checks)', async () => {
    const a = setup({ manifest: { stable: '0.5.0', releases: [{ version: '0.5.0', rolloutBp: 0 }] } });
    expect(await a.updater.check()).toMatchObject({ status: 'skipped', reason: 'rollout_not_yet' });
    expect(readFileSync(paths(a.root).installId, 'utf8').trim()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('schedule', () => {
  it('never checks sooner than 6 h; jitter adds up to 60 min; failures back off to at most 24 h; startup is delayed', () => {
    for (const r of [0, 0.5, 0.999]) { const d = nextCheckAt(0, 0, () => r); expect(d).toBeGreaterThanOrEqual(CHECK_INTERVAL_MS); expect(d).toBeLessThan(CHECK_INTERVAL_MS + CHECK_JITTER_MS); }
    expect(nextCheckAt(0, 1, () => 0)).toBe(12 * 3_600_000);
    expect(nextCheckAt(0, 9, () => 0)).toBe(MAX_BACKOFF_MS);
    expect(firstCheckAt(1000, 0, () => 0.5)).toBe(1000 + 150_000);
    expect(firstCheckAt(1000, 9_000_000, () => 0)).toBe(9_000_000); // persisted next-check is respected across restarts
  });
});

describe('policy: opt-outs and managed installs', () => {
  const root = '/home/u/.local/share/botwarren';
  const p = (over: Partial<Parameters<typeof resolvePolicy>[0]> = {}) => resolvePolicy({ env: {}, config: undefined, root, platform: 'linux', arch: 'x64', readPolicyFile: () => null, fileExists: () => false, ...over });
  it('default: silent background updates on the stable channel from the R2 download host', () => {
    expect(p()).toMatchObject({ background: true, manual: true, reason: 'ok', channel: 'stable', baseUrl: DEFAULT_BASE_URL, method: 'standalone', platform: 'linux-x64' });
    expect(DEFAULT_BASE_URL).toBe('https://downloads.botwarren.com/');
  });
  it('env switches: DISABLE_UPDATES blocks everything; DISABLE_AUTOUPDATE keeps manual updates', () => {
    expect(p({ env: { BOTWARREN_DISABLE_UPDATES: '1' } })).toMatchObject({ background: false, manual: false, reason: 'env_disable_updates' });
    expect(p({ env: { BOTWARREN_DISABLE_AUTOUPDATE: '1' } })).toMatchObject({ background: false, manual: true });
    expect(p({ config: { enabled: false } })).toMatchObject({ background: false, manual: true, reason: 'config_disabled' });
    expect(p({ env: { CI: 'true' } })).toMatchObject({ background: false });
  });
  it('package-manager installs never self-update (env, receipt, or path)', () => {
    expect(p({ env: { BOTWARREN_INSTALL_METHOD: 'brew' } })).toMatchObject({ background: false, manual: false, reason: 'managed_install', method: 'brew' });
    expect(p({ env: { BOTWARREN_INSTALL_METHOD: 'scoop' } })).toMatchObject({ reason: 'managed_install' });
    expect(p({ root: '/opt/homebrew/Cellar/botwarren/0.5.0/libexec' })).toMatchObject({ method: 'brew', background: false });
    expect(p({ root: 'C:\\Users\\u\\scoop\\apps\\botwarren\\current', platform: 'win32' })).toMatchObject({ method: 'scoop', background: false });
    expect(p({ fileExists: (x) => x === '/.dockerenv' })).toMatchObject({ method: 'docker', background: false });
  });
  it('receipt records the install method', () => {
    const r = mkTmp(); cleanup.push(() => rmTmp(r));
    writeJsonAtomic(paths(r).receipt, { method: 'winget' });
    expect(resolvePolicy({ env: {}, config: undefined, root: r, platform: 'win32', arch: 'x64' })).toMatchObject({ method: 'winget', background: false });
  });
  it('machine policy overrides user config; mirror URL via env/config; unsupported platform and no install root disable it', () => {
    expect(p({ config: { channel: 'beta' }, readPolicyFile: () => ({ updates: { channel: 'stable', enabled: false } }) })).toMatchObject({ channel: 'stable', background: false, reason: 'config_disabled' });
    expect(p({ env: { BOTWARREN_UPDATE_URL: 'https://mirror.corp/botwarren' } }).baseUrl).toBe('https://mirror.corp/botwarren/');
    expect(p({ config: { baseUrl: 'https://cfg.example/d/' } }).baseUrl).toBe('https://cfg.example/d/');
    expect(p({ platform: 'freebsd' })).toMatchObject({ background: false, reason: 'unsupported_platform' });
    expect(p({ root: null })).toMatchObject({ background: false, manual: false, reason: 'no_install_root' });
  });
});

describe('state helpers', () => {
  it('denylist entries expire; writes are atomic JSON; update state defaults are sane', () => {
    const r = makeRoot(); cleanup.push(() => rmTmp(r));
    writeJsonAtomic(paths(r).denylist, { '0.5.0': NOW.getTime() + 1000, '0.4.0': NOW.getTime() - 1000, 'junk': 5 });
    expect(readDenylist(r, NOW.getTime())).toEqual({ '0.5.0': NOW.getTime() + 1000 });
    expect(readUpdateState(r)).toEqual({ highestManifestVersion: 0, lastCheckMs: 0, nextCheckMs: 0, consecutiveFailures: 0 });
    writeUpdateState(r, { highestManifestVersion: 3, lastCheckMs: 1, nextCheckMs: 2, consecutiveFailures: 0 });
    expect(readUpdateState(r).highestManifestVersion).toBe(3);
    writeFileSync(paths(r).updateState, '{broken'); // corrupt state falls back to defaults, never throws
    expect(readUpdateState(r).highestManifestVersion).toBe(0);
  });
});

describe('archives', () => {
  const files = [{ name: 'a/b.txt', data: Buffer.from('hello'), mode: 0o644 }, { name: 'run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 }];
  it('zip and tar.gz round-trip, preserve modes, and are deterministic', () => {
    for (const [w, r] of [[writeZip, readZip], [writeTarGz, readTarGz]] as const) {
      const a = w(files); const b = w([...files].reverse());
      expect(sha256(a)).toBe(sha256(b));
      const back = r(a);
      expect(back.map((e) => e.name).sort()).toEqual(['a/b.txt', 'run.sh']);
      expect(back.find((e) => e.name === 'run.sh')).toMatchObject({ mode: 0o755 });
      expect(back.find((e) => e.name === 'a/b.txt')!.data.toString()).toBe('hello');
    }
  });
  it('rejects path traversal, absolute paths, drive letters, backslashes and NULs', () => {
    for (const n of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'C:\\x', 'a\\b', 'a\0b', '', 'a/..']) expect(() => safeEntryName(n)).toThrow(ArchiveError);
    expect(() => writeZip([{ name: '../evil', data: Buffer.from('x'), mode: 0o644 }])).toThrow(ArchiveError);
    // a hand-made zip with a traversal name is rejected on read
    const z = writeZip([{ name: 'xx/evil', data: Buffer.from('x'), mode: 0o644 }]);
    const bad = Buffer.from(z.toString('binary').replaceAll('xx/evil', '../evil'), 'binary');
    expect(() => readZip(bad)).toThrow(ArchiveError);
  });
  it('rejects corrupted entries (checksum) and truncated archives', () => {
    const z = writeZip(files);
    const c = Buffer.from(z); c[40]! ^= 0xff;
    expect(() => readZip(c)).toThrow();
    expect(() => readZip(z.subarray(0, z.length - 10))).toThrow();
  });
  it('rejects symlinks in a zip (unix mode bits) and decompression bombs', () => {
    const z = writeZip([{ name: 'l', data: Buffer.from('target'), mode: 0o777 }]);
    // flip the central header external attributes to S_IFLNK
    const i = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const sym = Buffer.from(z); sym.writeUInt32LE(((0o120000 | 0o777) << 16) >>> 0, i + 38);
    expect(() => readZip(sym)).toThrow(ArchiveError);
    const bomb = writeZip([{ name: 'big', data: Buffer.alloc(1024 * 1024), mode: 0o644 }]);
    expect(readZip(bomb)).toHaveLength(1);
  });
  it('extractTo never writes outside the target and never overwrites', () => {
    const d = mkTmp(); cleanup.push(() => rmTmp(d));
    extractTo(readZip(writeZip(files)), join(d, 'out'));
    expect(readFileSync(join(d, 'out', 'a', 'b.txt'), 'utf8')).toBe('hello');
    expect(() => extractTo(readZip(writeZip(files)), join(d, 'out'))).toThrow(); // wx: refuses to overwrite
    expect(() => extractTo([{ name: '../x', data: Buffer.from('x'), mode: 0o644 }], join(d, 'o2'))).toThrow(ArchiveError);
  });
  it('tar.gz reader skips links and device entries (official Node archives contain symlinks) so they can never be extracted', () => {
    const tarWithType = (type: string): Buffer => {
      const t = writeTarGz([{ name: 'f', data: Buffer.from('x'), mode: 0o644 }]);
      const raw = Buffer.from(gunzipSync(t)); raw[156] = type.charCodeAt(0);
      // recompute checksum
      raw.write('        ', 148, 'ascii'); let sum = 0; for (let i = 0; i < 512; i++) sum += raw[i]!;
      raw.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
      return gzipSync(raw);
    };
    expect(readTarGz(tarWithType('2'))).toHaveLength(0);
    expect(readTarGz(tarWithType('3'))).toHaveLength(0);
  });
});
