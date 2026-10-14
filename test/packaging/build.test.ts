/** Packaging script tests that need NO network: runtime verification, signing stages (skip/plan/credentials), templates, installer lint. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readTarGz, readZip, writeTarGz, writeZip } from '../../src/update/archive.ts';
import { Manifest } from '../../src/update/manifest.ts';
import { PINNED_PUBLIC_KEYS } from '../../src/update/keys.ts';
// @ts-expect-error plain JS modules without types
import { NODE_TARGETS, archiveName, extractNode, fetchRuntimes, parseShasums, verifyArchive } from '../../scripts/lib/node-runtime.mjs';
// @ts-expect-error plain JS modules without types
import { MAC_ENV, WIN_ENV, executePlan, macNotaryAuth, planSigning, signStage, signableFiles } from '../../scripts/lib/signing.mjs';
// @ts-expect-error plain JS modules without types
import { renderAll, renderTemplate, templateVars } from '../../scripts/render-package-templates.mjs';
// @ts-expect-error plain JS modules without types
import { buildRelease } from '../../scripts/build-release.mjs';
import { mkTmp, rmTmp } from '../update/kit.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('pinned Node runtime verification (offline)', () => {
  const V = '24.21.0';
  const fakeNodeTar = (target: string) => {
    const t = NODE_TARGETS[target];
    const root = `node-v${V}-${t.slug}/`;
    const entries = [{ name: `${root}${t.binDir}${t.bin}`, data: Buffer.from('NODE-BINARY'), mode: 0o755 }, { name: `${root}LICENSE`, data: Buffer.from('lic'), mode: 0o644 }, { name: `${root}include/node/node.h`, data: Buffer.from('h'), mode: 0o644 }];
    return t.ext === 'zip' ? writeZip(entries) : writeTarGz(entries);
  };

  it('parses SHASUMS256.txt and verifies an archive against it AND the committed pin', () => {
    const data = fakeNodeTar('linux-x64');
    const name = archiveName(V, 'linux-x64');
    const sums = parseShasums(`${sha(data)}  ${name}\n${'0'.repeat(64)}  other.tar.gz\n garbage\n`);
    expect(sums.get(name)).toBe(sha(data));
    expect(verifyArchive({ name, data, shasums: sums, pin: sha(data) })).toBe(sha(data));
    expect(() => verifyArchive({ name, data: Buffer.concat([data, Buffer.from('x')]), shasums: sums, pin: sha(data) })).toThrow(/SHASUMS256/);
    expect(() => verifyArchive({ name, data, shasums: sums, pin: '1'.repeat(64) })).toThrow(/pinned hash/);
    expect(() => verifyArchive({ name: 'unlisted.tar.gz', data, shasums: sums, pin: undefined })).toThrow(/not listed/);
    expect(() => verifyArchive({ name, data, shasums: undefined, pin: undefined })).toThrow(/no hash/);
  });

  it('extracts only the node binary and the licence from every platform layout (zip and tar.gz)', () => {
    for (const target of Object.keys(NODE_TARGETS)) {
      const r = extractNode(fakeNodeTar(target), V, target);
      expect(r.bin.data.toString()).toBe('NODE-BINARY');
      expect(r.bin.name).toBe(target.startsWith('win') ? 'node.exe' : 'node');
      expect(r.license!.toString()).toBe('lic');
    }
    const empty = writeTarGz([{ name: `node-v${V}-linux-x64/README`, data: Buffer.from('x'), mode: 0o644 }]);
    expect(() => extractNode(empty, V, 'linux-x64')).toThrow(/not found/);
  });

  it('runs entirely from a cache when offline; a cached file that fails verification is deleted and the build fails', async () => {
    const dir = mkTmp(); cleanup.push(() => rmTmp(dir));
    const cache = join(dir, 'cache'); const pins = join(dir, 'pins.json');
    const targets = ['linux-x64', 'win-x64'];
    const files: Record<string, Buffer> = Object.fromEntries(targets.map((t) => [archiveName(V, t), fakeNodeTar(t) as Buffer]));
    mkdirSync(join(cache, `v${V}`), { recursive: true });
    for (const [n, d] of Object.entries(files)) writeFileSync(join(cache, `v${V}`, n), d);
    writeFileSync(join(cache, `v${V}`, 'SHASUMS256.txt'), Object.entries(files).map(([n, d]) => `${sha(d)}  ${n}`).join('\n'));
    writeFileSync(pins, JSON.stringify({ version: V, sha256: Object.fromEntries(Object.entries(files).map(([n, d]) => [n, sha(d)])) }));
    const noNet = (async () => { throw new Error('network must not be used'); }) as unknown as typeof fetch;
    const ok = await fetchRuntimes({ version: V, targets, cacheDir: cache, pinFile: pins, offline: true, fetchImpl: noNet });
    expect([...ok.keys()]).toEqual(targets);
    // even ONLINE, cached files are not downloaded again
    expect((await fetchRuntimes({ version: V, targets, cacheDir: cache, pinFile: pins, fetchImpl: noNet })).size).toBe(2);
    // poisoned cache: pin and SHASUMS disagree with the file
    writeFileSync(join(cache, `v${V}`, archiveName(V, 'linux-x64')), Buffer.concat([files[archiveName(V, 'linux-x64')]!, Buffer.from('!')]));
    await expect(fetchRuntimes({ version: V, targets, cacheDir: cache, pinFile: pins, offline: true, fetchImpl: noNet })).rejects.toThrow(/does not match/);
    expect(readdirSync(join(cache, `v${V}`))).not.toContain(archiveName(V, 'linux-x64')); // removed
    // offline with a missing archive fails with instructions instead of hanging
    await expect(fetchRuntimes({ version: V, targets, cacheDir: cache, pinFile: pins, offline: true, fetchImpl: noNet })).rejects.toThrow(/offline.*not cached/);
  });

  it('refuses an unpinned or version-mismatched runtime unless --update-pins is given', async () => {
    const dir = mkTmp(); cleanup.push(() => rmTmp(dir));
    const data = fakeNodeTar('linux-x64'); const n = archiveName(V, 'linux-x64');
    mkdirSync(join(dir, 'c', `v${V}`), { recursive: true });
    writeFileSync(join(dir, 'c', `v${V}`, n), data); writeFileSync(join(dir, 'c', `v${V}`, 'SHASUMS256.txt'), `${sha(data)}  ${n}\n`);
    const noNet = (async () => { throw new Error('no network'); }) as unknown as typeof fetch;
    const pinFile = join(dir, 'pins.json');
    await expect(fetchRuntimes({ version: V, targets: ['linux-x64'], cacheDir: join(dir, 'c'), pinFile, offline: true, fetchImpl: noNet })).rejects.toThrow(/no pinned hash/);
    writeFileSync(pinFile, JSON.stringify({ version: '22.0.0', sha256: {} }));
    await expect(fetchRuntimes({ version: V, targets: ['linux-x64'], cacheDir: join(dir, 'c'), pinFile, offline: true, fetchImpl: noNet })).rejects.toThrow(/pins Node 22.0.0/);
    await fetchRuntimes({ version: V, targets: ['linux-x64'], cacheDir: join(dir, 'c'), pinFile, offline: true, updatePins: true, fetchImpl: noNet });
    expect(JSON.parse(readFileSync(pinFile, 'utf8'))).toEqual({ version: V, sha256: { [n]: sha(data) } });
  });

  it('the committed packaging/node-pins.json pins a full set of real Node 24 LTS archives', () => {
    const pins = JSON.parse(readFileSync(join(ROOT, 'packaging', 'node-pins.json'), 'utf8')) as { version: string; sha256: Record<string, string> };
    expect(pins.version).toMatch(/^24\.\d+\.\d+$/);
    for (const t of Object.keys(NODE_TARGETS)) expect(pins.sha256[archiveName(pins.version, t)]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('build-release (no network)', () => {
  const stub = (name = 'node') => new Map(['win-x64', 'mac-arm64', 'linux-x64'].map((t) => [t, { bin: { name: t.startsWith('win') ? 'node.exe' : name, data: Buffer.from(`NODE-${t}`), mode: 0o755 }, license: null, archiveSha256: 'x' }]));

  it('produces per-OS archives with the installed layout, a schema-valid manifest, an install index and SHA256SUMS', async () => {
    const out = mkTmp(); cleanup.push(() => rmTmp(out));
    const r = await buildRelease({ version: '0.7.0', targets: ['win-x64', 'mac-arm64', 'linux-x64'], out, runtimes: stub(), nodeVersion: '24.21.0', log: () => {}, env: {}, commit: 'abc1234', rolloutBp: 1000 });
    const names = readdirSync(r.dir).sort();
    expect(names).toEqual(['SHA256SUMS', 'botwarren-0.7.0-linux-x64.tar.gz', 'botwarren-0.7.0-mac-arm64.tar.gz', 'botwarren-0.7.0-win-x64.zip', 'bundle-0.7.0.zip', 'install-index.txt', 'install.ps1', 'install.sh', 'manifest.json']);
    const m = Manifest.parse(JSON.parse(readFileSync(join(r.dir, 'manifest.json'), 'utf8')));
    expect(m.channels.stable).toBe('0.7.0');
    const rel = m.releases['0.7.0']!;
    expect(rel).toMatchObject({ rolloutBp: 1000, critical: false, commit: 'abc1234', minRuntime: '24.21.0' });
    for (const [t, a] of Object.entries(rel.full)) {
      const bytes = readFileSync(join(r.dir, a.url));
      expect(sha(bytes)).toBe(a.sha256); expect(bytes.length).toBe(a.size);
      const entries = t.startsWith('win') ? readZip(bytes) : readTarGz(bytes);
      const have = new Set(entries.map((e) => e.name));
      for (const f of ['launcher/launcher.mjs', 'versions/0.7.0/agent.mjs', 'versions/0.7.0/cli.mjs', 'versions/0.7.0/ops.html', 'versions/0.7.0/VERSION', 'current.json', 'runtime/NODE_VERSION', t.startsWith('win') ? 'runtime/node/node.exe' : 'runtime/node/node', t.startsWith('win') ? 'uninstall.ps1' : 'uninstall.sh']) expect(have.has(f), `${t}: ${f}`).toBe(true);
      expect(entries.find((e) => e.name.startsWith('runtime/node/node'))!.mode).toBe(0o755);
      expect(JSON.parse(entries.find((e) => e.name === 'current.json')!.data.toString())).toMatchObject({ version: '0.7.0', state: 'stable' });
      // nothing private ships: no secrets, databases, tests, sources, env files
      for (const e of entries) expect(e.name).not.toMatch(/\.env|secret|\.db|\.test\.|node_modules|\.git|\.key|\.pem/i);
    }
    // the update bundle is exactly the four app files
    expect(readZip(readFileSync(join(r.dir, 'bundle-0.7.0.zip'))).map((e) => e.name).sort()).toEqual(['VERSION', 'agent.mjs', 'cli.mjs', 'ops.html']);
    const index = readFileSync(join(r.dir, 'install-index.txt'), 'utf8').trim().split('\n');
    expect(index).toHaveLength(3);
    expect(index[0]!.split(' ')[0]).toBe('0.7.0');
    expect(readFileSync(join(r.dir, 'SHA256SUMS'), 'utf8')).toContain(`${rel.bundle.sha256}  bundle-0.7.0.zip`);
    // the launcher bundle is dependency-free (no zod, no bundled server code)
    const launcher = readZip(readFileSync(join(r.dir, 'botwarren-0.7.0-win-x64.zip'))).find((e) => e.name === 'launcher/launcher.mjs')!.data.toString();
    expect(launcher).not.toMatch(/zod|private-service|better-sqlite|node:sqlite/);
    expect(launcher.length).toBeLessThan(60_000);
  }, 60_000);

  it('--no-manifest (how releases ship before a production key exists): archives, installers and SHA256SUMS only, no manifest, index or update bundle', async () => {
    const out = mkTmp(); cleanup.push(() => rmTmp(out));
    const r = await buildRelease({ version: '0.7.0', targets: ['linux-x64'], out, runtimes: stub(), nodeVersion: '24.21.0', log: () => {}, env: {}, commit: 'abc1234', noManifest: true });
    expect(r.manifest).toBeNull();
    expect(readdirSync(r.dir).sort()).toEqual(['SHA256SUMS', 'botwarren-0.7.0-linux-x64.tar.gz', 'install.ps1', 'install.sh']);
    const sums = readFileSync(join(r.dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums).toHaveLength(3);
    for (const line of sums) { const [h, n] = line.split('  '); expect(sha(readFileSync(join(r.dir, n!)))).toBe(h); }
  }, 60_000);

  it('is reproducible: two builds of the same sources give identical archives and hashes', async () => {
    const a = mkTmp(); const b = mkTmp(); cleanup.push(() => { rmTmp(a); rmTmp(b); });
    const opts = { version: '0.7.1', targets: ['linux-x64'], runtimes: stub(), nodeVersion: '24.21.0', log: () => {}, env: {}, commit: 'abc1234' };
    const x = await buildRelease({ ...opts, out: a }); const y = await buildRelease({ ...opts, out: b });
    for (const f of ['botwarren-0.7.1-linux-x64.tar.gz', 'bundle-0.7.1.zip']) expect(sha(readFileSync(join(x.dir, f)))).toBe(sha(readFileSync(join(y.dir, f))));
  }, 60_000);

  it('merges a previous manifest (monotonic manifestVersion, blocked and rollbackFrom carried over) and keeps stable first in the index', async () => {
    const out = mkTmp(); cleanup.push(() => rmTmp(out));
    const base = { targets: ['linux-x64'], runtimes: stub(), nodeVersion: '24.21.0', log: () => {}, env: {}, commit: 'abc1234' };
    const r1 = await buildRelease({ ...base, version: '0.7.0', out: join(out, 'a'), manifestVersion: 100 });
    const prev = JSON.parse(readFileSync(join(r1.dir, 'manifest.json'), 'utf8'));
    prev.blocked = ['0.6.0']; writeFileSync(join(out, 'prev.json'), JSON.stringify(prev));
    const r2 = await buildRelease({ ...base, version: '0.7.1', out: join(out, 'b'), previous: join(out, 'prev.json') });
    expect(r2.manifest.manifestVersion).toBeGreaterThan(100);
    expect(r2.manifest.blocked).toEqual(['0.6.0']);
    expect(Object.keys(r2.manifest.releases).sort()).toEqual(['0.7.0', '0.7.1']);
    expect(readFileSync(join(r2.dir, 'install-index.txt'), 'utf8').split('\n')[0]!.startsWith('0.7.1 ')).toBe(true);
  }, 60_000);

  it('--release refuses to build while a DEV key is pinned (release gate)', async () => {
    expect(PINNED_PUBLIC_KEYS.some((k) => k.dev)).toBe(true);
    const out = mkTmp(); cleanup.push(() => rmTmp(out));
    await expect(buildRelease({ version: '0.7.2', out, runtime: false, release: true, log: () => {}, env: {} })).rejects.toThrow(/DEV public key/);
  });

  it('--no-runtime builds only the update bundle and manifest (no full archives)', async () => {
    const out = mkTmp(); cleanup.push(() => rmTmp(out));
    const r = await buildRelease({ version: '0.7.3', out, runtime: false, log: () => {}, env: {}, commit: 'abc1234' });
    expect(readdirSync(r.dir).filter((n) => /\.(zip|tar\.gz)$/.test(n))).toEqual(['bundle-0.7.3.zip']);
    expect(r.manifest.releases['0.7.3']!.full).toEqual({});
  }, 60_000);
});

describe('optional signing stages', () => {
  const winFiles = ['runtime/node/node.exe', 'launcher/launcher.mjs', 'uninstall.ps1', 'bin/botwarren.cmd', 'versions/1.0.0/agent.mjs'];
  const winEnv = Object.fromEntries(WIN_ENV.map((k: string) => [k, `v-${k}`])) as Record<string, string>;
  const macEnv = { APPLE_SIGNING_IDENTITY: 'Developer ID Application: TurboKast Ltd (ABCDE12345)', APPLE_NOTARY_KEYCHAIN_PROFILE: 'bw-notary' };

  it('skips cleanly (with the exact missing variable names) when credentials are absent, and fails only under --require-signing', () => {
    const p = planSigning({ platform: 'win', files: winFiles, env: {}, host: 'win32', stageDir: '/s' });
    expect(p).toMatchObject({ status: 'skipped', reason: expect.stringContaining('credentials') });
    expect(p.missing).toEqual(WIN_ENV);
    expect(planSigning({ platform: 'mac', files: ['runtime/node/node'], env: {}, host: 'darwin', stageDir: '/s' }).missing).toEqual(MAC_ENV);
    const logs: string[] = [];
    expect(() => signStage({ platform: 'win', stageDir: mkTmp(), env: {}, host: 'win32', log: (m: string) => logs.push(m) })).not.toThrow();
    const d = mkTmp(); cleanup.push(() => rmTmp(d));
    mkdirSync(join(d, 'runtime', 'node'), { recursive: true }); writeFileSync(join(d, 'runtime', 'node', 'node.exe'), 'x'); writeFileSync(join(d, 'uninstall.ps1'), 'x');
    expect(() => signStage({ platform: 'win', stageDir: d, env: {}, host: 'win32', requireSigning: true, log: () => {} })).toThrow(/credentials not set/);
    expect(() => signStage({ platform: 'linux', stageDir: d, env: {}, requireSigning: true, log: () => {} })).not.toThrow(); // nothing to sign on Linux
  });

  it('skips on the wrong host even with credentials (Authenticode needs Windows, codesign needs macOS)', () => {
    expect(planSigning({ platform: 'win', files: winFiles, env: winEnv, host: 'linux', stageDir: '/s' })).toMatchObject({ status: 'skipped', reason: expect.stringContaining('Windows host') });
    expect(planSigning({ platform: 'mac', files: ['runtime/node/node'], env: macEnv, host: 'linux', stageDir: '/s' })).toMatchObject({ status: 'skipped', reason: expect.stringContaining('macOS host') });
  });

  it('Windows plan: signtool with Artifact Signing dlib + metadata, SHA256, Microsoft timestamp; signs .ps1/.exe but not the OpenJS node.exe unless asked', () => {
    const p = planSigning({ platform: 'win', files: winFiles, env: winEnv, host: 'win32', stageDir: 'C:/s' });
    expect(p.status).toBe('planned');
    expect(p.steps.map((s: { label: string }) => s.label)).toEqual(['signtool sign uninstall.ps1']);
    const a = p.steps[0].args as string[];
    expect(a).toEqual(expect.arrayContaining(['sign', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256', '/dlib', winEnv.ARTIFACT_SIGNING_DLIB!, '/dmdf']));
    expect(signableFiles(winFiles, 'win', { BOTWARREN_SIGN_NODE: '1' })).toContain('runtime/node/node.exe');
    expect(signableFiles(winFiles, 'win', {})).not.toContain('runtime/node/node.exe');
    // secrets never appear in a plan's command line
    expect(JSON.stringify(p.steps)).not.toContain(winEnv.AZURE_CLIENT_SECRET!);
  });

  it('macOS plan: hardened-runtime codesign with entitlements, verify, zip, notarytool --wait; each credential style is supported and secrets are redacted in the log', () => {
    const p = planSigning({ platform: 'mac', files: ['runtime/node/node', 'launcher/launcher.mjs'], env: macEnv, host: 'darwin', stageDir: '/s', entitlements: '/e.plist' });
    expect(p.status).toBe('planned');
    const cmds = p.steps.map((s: { cmd: string; args: string[] }) => `${s.cmd} ${s.args[0]}`);
    expect(cmds).toEqual(['codesign --force', 'codesign --verify', 'ditto -c', 'xcrun notarytool']);
    expect(p.steps[0].args).toEqual(expect.arrayContaining(['--options', 'runtime', '--timestamp', '--entitlements', '/e.plist', '--sign', macEnv.APPLE_SIGNING_IDENTITY]));
    expect(macNotaryAuth({ APPLE_ID: 'a@b.c', APPLE_TEAM_ID: 'T', APPLE_APP_SPECIFIC_PASSWORD: 'pw' })).toEqual(['--apple-id', 'a@b.c', '--team-id', 'T', '--password', 'pw']);
    expect(macNotaryAuth({ APPLE_NOTARY_KEY_PATH: '/k.p8', APPLE_NOTARY_KEY_ID: 'K', APPLE_NOTARY_ISSUER: 'I' })).toEqual(['--key', '/k.p8', '--key-id', 'K', '--issuer', 'I']);
    expect(macNotaryAuth({})).toBeNull();
    const noNotary = planSigning({ platform: 'mac', files: ['runtime/node/node'], env: { APPLE_SIGNING_IDENTITY: 'x' }, host: 'darwin', stageDir: '/s', entitlements: '/e.plist' });
    expect(noNotary).toMatchObject({ status: 'planned', notarised: false, note: expect.stringContaining('NOT notarised') });
    // dry-run executes nothing and redacts the notary password
    const pw = planSigning({ platform: 'mac', files: ['runtime/node/node'], env: { APPLE_SIGNING_IDENTITY: 'x', APPLE_ID: 'a@b.c', APPLE_TEAM_ID: 'T', APPLE_APP_SPECIFIC_PASSWORD: 'SECRET-PW' }, host: 'darwin', stageDir: '/s', entitlements: '/e.plist' });
    const logs: string[] = []; let ran = 0;
    executePlan(pw, { dryRun: true, run: () => { ran++; return { status: 0 }; }, log: (m: string) => logs.push(m) });
    expect(ran).toBe(0);
    expect(logs.join('\n')).not.toContain('SECRET-PW');
    expect(logs.join('\n')).toContain('***');
    // a failing tool aborts the build
    expect(() => executePlan(p, { run: () => ({ status: 1 }), log: () => {} })).toThrow(/failed/);
    expect(executePlan(p, { run: () => ({ status: 0 }), log: () => {} })).toMatchObject({ status: 'signed' });
  });
});

describe('Homebrew / Scoop templates', () => {
  const manifest = () => {
    const mk = (t: string) => ({ url: `botwarren-0.7.0-${t}.tar.gz`, sha256: sha(Buffer.from(t)), size: 10 });
    return { schema: 1, manifestVersion: 1, issued: '2026-10-14T00:00:00Z', expires: '2026-10-28T00:00:00Z', channels: { stable: '0.7.0' }, minSupported: '0.1.0', blocked: [], rollbackFrom: [],
      releases: { '0.7.0': { protocol: { min: 1, max: 1 }, rolloutBp: 10000, rolloutSalt: 's', critical: false, bundle: { url: 'bundle-0.7.0.zip', sha256: sha(Buffer.from('b')), size: 10 }, full: Object.fromEntries(['win-x64', 'win-arm64', 'mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64'].map((t) => [t, mk(t)])) } } };
  };
  it('render with the real URLs and hashes, use the Apache-2.0 licence, and refuse unfilled placeholders', () => {
    const files = renderAll({ manifest: manifest(), baseUrl: 'https://downloads.botwarren.com/' });
    expect(files['botwarren.rb']).toContain('version "0.7.0"');
    expect(files['botwarren.rb']).toContain(`url "https://downloads.botwarren.com/botwarren-0.7.0-mac-arm64.tar.gz"`);
    expect(files['botwarren.rb']).toContain(`sha256 "${sha(Buffer.from('linux-x64'))}"`);
    expect(files['botwarren.rb']).toContain('BOTWARREN_INSTALL_METHOD=brew');
    expect(files['botwarren.rb']).toContain('github.com/turbokast/botwarren-ship');
    expect(files['botwarren.rb']).toContain('license "Apache-2.0"');
    const scoop = JSON.parse(files['botwarren.json']);
    expect(scoop.architecture['64bit'].hash).toBe(sha(Buffer.from('win-x64')));
    expect(scoop.env_set.BOTWARREN_INSTALL_METHOD).toBe('scoop');
    expect(scoop.homepage).toBe('https://github.com/turbokast/botwarren-ship');
    expect(() => renderTemplate('x @MISSING_VAR@ y', templateVars(manifest()))).toThrow(/unfilled/);
  });
  it('the formula is Ruby-shaped (balanced do/end) and never publishes anything by itself', () => {
    const rb = renderAll({ manifest: manifest(), baseUrl: 'https://x/' })['botwarren.rb']!;
    const opens = (rb.match(/\b(do|def|class|if)\b(?!.*\bend\b\s*$)/gm) ?? []).length;
    expect(opens).toBeGreaterThan(5);
    expect((rb.match(/^\s*end\s*$/gm) ?? []).length).toBeGreaterThanOrEqual(10);
  });
});

describe('installer hygiene (static checks; real Windows runs are UNVERIFIED, see the architecture doc)', () => {
  const read = (n: string) => readFileSync(join(ROOT, 'packaging', n), 'utf8');
  const codeLines = (t: string) => t.split('\n').filter((l) => !l.trim().startsWith('#'));

  it('PowerShell scripts are pure ASCII with balanced braces and parentheses', () => {
    for (const f of ['install.ps1', 'uninstall.ps1']) {
      const t = read(f);
      // eslint-disable-next-line no-control-regex
      expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(t), `${f} must be ASCII`).toBe(true);
      const code = codeLines(t).join('\n').replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""');
      expect((code.match(/\{/g) ?? []).length).toBe((code.match(/\}/g) ?? []).length);
      expect((code.match(/\(/g) ?? []).length).toBe((code.match(/\)/g) ?? []).length);
    }
  });

  it('no PowerShell execution-policy bypass and no hidden-PowerShell launcher anywhere in the installers or the scheduled task', () => {
    for (const f of ['install.ps1', 'uninstall.ps1', 'install.sh', 'uninstall.sh']) {
      const code = codeLines(read(f)).join('\n');
      expect(code, f).not.toMatch(/ExecutionPolicy/i);
      expect(code, f).not.toMatch(/-WindowStyle\s+Hidden/i);
      expect(code, f).not.toMatch(/\bBypass\b/);
    }
    const ps = read('install.ps1');
    // the task runs the bundled node.exe directly
    expect(ps).toMatch(/New-ScheduledTaskAction -Execute \(Join-Path \$Root 'runtime\\node\\node\.exe'\)/);
    expect(ps).not.toMatch(/New-ScheduledTaskAction -Execute[^\n]*powershell/i);
    expect(ps).toMatch(/-RunLevel Limited/); // never elevated
    expect(ps).not.toMatch(/RunLevel Highest|runas|Start-Process[^\n]*-Verb/i);
  });

  it('installers verify before they install: checksum, safe archive paths, then the signed manifest, in that order', () => {
    for (const f of ['install.sh', 'install.ps1']) {
      const t = codeLines(read(f)).join('\n');
      const iSum = t.search(/checksum (ok|mismatch)/); const iPath = t.search(/unsafe paths/); const iSig = t.search(/verify-release/); const iInstall = t.search(/Installing/);
      expect(iSum, f).toBeGreaterThan(-1); expect(iSum).toBeLessThan(iPath); expect(iPath).toBeLessThan(iSig); expect(iSig).toBeLessThan(iInstall);
    }
    const sh = read('install.sh');
    expect(sh).toContain('main "$@"'); // the whole script is parsed before anything runs (partial download safety)
    expect(sh).not.toMatch(/\bsudo\b|\bsu -c\b/);
    expect(sh).toContain('downloads.botwarren.com');
    expect(read('install.ps1')).toContain('downloads.botwarren.com');
    for (const f of ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1']) expect(read(f)).toContain('github.com/turbokast/botwarren-ship');
  });

  it('every shipped installer is per-user: no system paths or machine-wide registry hives are written', () => {
    for (const f of ['install.sh', 'install.ps1']) {
      const code = codeLines(read(f)).join('\n');
      expect(code, f).not.toMatch(/HKLM|\/usr\/local|\/etc\/|Program Files|ProgramData|\/Library\/LaunchDaemons/);
    }
  });

  it('the update host default is the R2 downloads host', () => {
    expect(readFileSync(join(ROOT, 'src', 'update', 'policy.ts'), 'utf8')).toContain("'https://downloads.botwarren.com/'");
  });
});

describe('tar writer interop', () => {
  it('GNU tar can list and extract what writeTarGz produces (real-world compatibility of the archives)', async () => {
    const { spawnSync } = await import('node:child_process');
    const d = mkTmp(); cleanup.push(() => rmTmp(d));
    const f = join(d, 'a.tar.gz');
    writeFileSync(f, writeTarGz([{ name: 'runtime/node/node', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 }, { name: 'current.json', data: Buffer.from('{}'), mode: 0o644 }]));
    const l = spawnSync('tar', ['-tzf', f], { encoding: 'utf8' });
    expect(l.status).toBe(0);
    expect(l.stdout.trim().split('\n').sort()).toEqual(['current.json', 'runtime/node/node']);
    mkdirSync(join(d, 'x'));
    expect(spawnSync('tar', ['-xzf', f, '-C', join(d, 'x')]).status).toBe(0);
    expect(readFileSync(join(d, 'x', 'current.json'), 'utf8')).toBe('{}');
    void gzipSync;
  });
});
