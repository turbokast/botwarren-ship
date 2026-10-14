/**
 * END-TO-END installer test on this machine: builds a real release (real bundles; the Node runtime is a stub that execs the
 * node running the tests, so no 40 MB download), signs its manifest, serves it from a local HTTP server and runs the REAL
 * packaging/install.sh and uninstall.sh with a throwaway HOME. The signature step needs the maintainers' DEV private key
 * (a PKCS#8 PEM kept outside the repository: set BOTWARREN_DEV_RELEASE_KEY or use ~/.config/botwarren/release-dev.key). Without it,
 * as on CI and for contributors, those tests are skipped, never faked.
 */
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signManifestBytes } from '../../src/update/verify.ts';
// @ts-expect-error plain JS module without types
import { buildRelease } from '../../scripts/build-release.mjs';
import { mkTmp, rmTmp } from '../update/kit.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const INSTALL = join(ROOT, 'packaging', 'install.sh');
const DEV_KEY = process.env.BOTWARREN_DEV_RELEASE_KEY ?? join(homedir(), '.config', 'botwarren', 'release-dev.key');
const haveKey = existsSync(DEV_KEY) && process.platform !== 'win32';

interface Built { dir: string; version: string }
let work: string; let server: Server; let port: number;
let rel: Built; let rel2: Built;
let files: Map<string, Buffer> = new Map();

const stubRuntime = () => new Map([['linux-x64', { bin: { name: 'node', data: Buffer.from(`#!/bin/sh\nexec "${process.execPath}" "$@"\n`), mode: 0o755 }, license: null, archiveSha256: 'x' }]]);

async function build(version: string, out: string, previous?: string): Promise<Built> {
  const r = await buildRelease({ version, targets: ['linux-x64'], out, runtimes: stubRuntime(), nodeVersion: '24.0.0', log: () => {}, env: {}, ...(previous ? { previous } : {}), commit: 'abcdef1' });
  const mf = join(r.dir, 'manifest.json');
  writeFileSync(`${mf}.sig`, signManifestBytes(readFileSync(mf), readFileSync(DEV_KEY), 'dev-1'));
  return { dir: r.dir, version };
}

function load(dir: string): void { files = new Map(readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).map((n) => [n, readFileSync(join(dir, n))])); }

beforeAll(async () => {
  if (!haveKey) return;
  work = mkTmp();
  rel = await build('0.5.0', join(work, 'r1'));
  rel2 = await build('0.5.1', join(work, 'r2'), join(rel.dir, 'manifest.json'));
  load(rel.dir);
  server = createServer((req, res) => { const b = files.get((req.url ?? '').slice(1)); if (!b) { res.writeHead(404); res.end(); return; } res.writeHead(200); res.end(b); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
}, 120_000);
afterAll(async () => { if (server) await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); if (work) rmTmp(work); });

/** ASYNC on purpose: the release server lives in this process, so a synchronous spawn would deadlock it. */
function run(script: string, args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolveP) => {
    const p = spawn('sh', [script, ...args], { env: { PATH: process.env.PATH ?? '', HOME: home, BOTWARREN_UPDATE_ALLOW_DEV_KEY: '1', TMPDIR: work, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); }); p.stderr.on('data', (c: Buffer) => { out += c.toString(); });
    const t = setTimeout(() => p.kill('SIGKILL'), 90_000);
    p.on('exit', (code) => { clearTimeout(t); resolveP({ code, out }); });
  });
}
const url = () => `http://127.0.0.1:${port}`;

describe.skipIf(!haveKey)('install.sh / uninstall.sh against a locally served, signed release', () => {
  it('installs: verifies, lays out side by side, writes the pointer and receipt, installs a working command', async () => {
    load(rel.dir);
    const home = join(work, 'home1'); mkdirSync(home);
    const r = await run(INSTALL, ['--base-url', url(), '--no-service'], home);
    expect(r.out).toContain('checksum ok');
    expect(r.out).toContain('is installed');
    expect(r.code).toBe(0);
    const root = join(home, '.local', 'share', 'botwarren');
    for (const f of ['runtime/node/node', 'runtime/NODE_VERSION', 'launcher/launcher.mjs', 'versions/0.5.0/agent.mjs', 'versions/0.5.0/cli.mjs', 'versions/0.5.0/ops.html', 'versions/0.5.0/VERSION', 'current.json', 'uninstall.sh', 'state/install-receipt.json']) expect(existsSync(join(root, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'))).toMatchObject({ version: '0.5.0', state: 'stable', knownGood: '0.5.0', previous: null });
    expect(JSON.parse(readFileSync(join(root, 'state', 'install-receipt.json'), 'utf8')).method).toBe('standalone');
    expect(statSync(join(root, 'state')).mode & 0o777).toBe(0o700);
    const v = spawnSync(join(home, '.local', 'bin', 'botwarren'), ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } });
    expect(v.stdout).toContain('0.5.0');
    const st = spawnSync(join(home, '.local', 'bin', 'botwarren'), ['update', 'status'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } });
    expect(st.stdout).toContain('install method: standalone');
    expect(st.stdout).toContain('downloads.botwarren.com'); // the default host, even though THIS install used a test base URL
    // no secrets, tokens or private keys anywhere in the install
    const all = spawnSync('grep', ['-rIl', '-e', 'BEGIN PRIVATE KEY', '-e', 'sk-ant-', root], { encoding: 'utf8' });
    expect(all.stdout.trim()).toBe('');
  });

  it('upgrading installs the new version side by side in TRIAL state (previous kept), leaving the old version intact', async () => {
    load(rel2.dir);
    const home = join(work, 'home1');
    const r = await run(INSTALL, ['--base-url', url(), '--no-service'], home);
    expect(r.code).toBe(0);
    const root = join(home, '.local', 'share', 'botwarren');
    expect(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'))).toMatchObject({ version: '0.5.1', previous: '0.5.0', knownGood: '0.5.0', state: 'trial', bootCount: 0 });
    expect(readdirSync(join(root, 'versions')).sort()).toEqual(['0.5.0', '0.5.1']);
  });

  it('uninstall --keep-config removes the program, the command and the data but keeps the config; a second run removes the rest', async () => {
    const home = join(work, 'home1');
    const cfg = join(home, '.config', 'botwarren-ship'); const data = join(home, '.local', 'share', 'botwarren-ship');
    mkdirSync(cfg, { recursive: true }); mkdirSync(data, { recursive: true });
    writeFileSync(join(cfg, 'config.json'), '{}'); writeFileSync(join(cfg, 'ship.secret'), 'x'.repeat(40)); writeFileSync(join(data, 'private.db'), 'x');
    const root = join(home, '.local', 'share', 'botwarren');
    const r = await run(join(root, 'uninstall.sh'), ['--yes', '--keep-config'], home);
    expect(r.code).toBe(0);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'botwarren'))).toBe(false);
    expect(existsSync(join(cfg, 'config.json'))).toBe(true);
    expect(existsSync(data)).toBe(false);
    // reinstall then full removal
    load(rel.dir);
    expect((await run(INSTALL, ['--base-url', url(), '--no-service'], home)).code).toBe(0);
    expect((await run(join(root, 'uninstall.sh'), ['--yes'], home)).code).toBe(0);
    expect(existsSync(cfg)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it('uninstall refuses without --yes when not on a terminal, and never removes a directory that is not an install', async () => {
    const home = join(work, 'home2'); mkdirSync(home, { recursive: true });
    const root = join(home, '.local', 'share', 'botwarren');
    mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'precious.txt'), 'mine');
    const UNINSTALL = join(ROOT, 'packaging', 'uninstall.sh');
    const a = await run(UNINSTALL, [], home);
    expect(a.code).toBe(1); // refused: not an install (and no terminal)
    expect(existsSync(join(root, 'precious.txt'))).toBe(true);
    const b = await run(UNINSTALL, ['--yes'], home, { BOTWARREN_INSTALL_DIR: home });
    expect(b.code).toBe(1);
    expect(existsSync(home)).toBe(true);
  });

  it('REFUSES a tampered archive (checksum) and installs nothing', async () => {
    load(rel.dir);
    const name = [...files.keys()].find((n) => n.endsWith('.tar.gz'))!;
    const evil = Buffer.from(files.get(name)!); evil[evil.length - 40]! ^= 0xff;
    files.set(name, evil);
    const home = join(work, 'home3'); mkdirSync(home);
    const r = await run(INSTALL, ['--base-url', url(), '--no-service'], home);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/checksum mismatch/);
    expect(existsSync(join(home, '.local', 'share', 'botwarren'))).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'botwarren'))).toBe(false);
  });

  it('REFUSES an archive whose hash was also changed in the index (attacker controls the host but cannot re-sign)', async () => {
    load(rel.dir);
    const { createHash } = await import('node:crypto');
    const { writeTarGz, readTarGz } = await import('../../src/update/archive.ts');
    const name = [...files.keys()].find((n) => n.endsWith('.tar.gz'))!;
    const entries = readTarGz(files.get(name)!);
    entries.find((e) => e.name.endsWith('agent.mjs'))!.data = Buffer.from('console.log("evil")');
    const evil = writeTarGz(entries);
    files.set(name, evil);
    const index = files.get('install-index.txt')!.toString().split('\n').map((l) => (l.includes(name) ? l.split(' ').map((f, i) => (i === 3 ? createHash('sha256').update(evil).digest('hex') : i === 4 ? String(evil.length) : f)).join(' ') : l)).join('\n');
    files.set('install-index.txt', Buffer.from(index));
    const home = join(work, 'home4'); mkdirSync(home);
    const r = await run(INSTALL, ['--base-url', url(), '--no-service'], home);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/signature check failed|archive hash is not the one/);
    expect(existsSync(join(home, '.local', 'share', 'botwarren'))).toBe(false);
  });

  it('REFUSES a manifest signed by an unknown key, and a dev key unless allowed', async () => {
    load(rel.dir);
    const k = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    files.set('manifest.json.sig', Buffer.from(signManifestBytes(files.get('manifest.json')!, k, 'dev-1'))); // claims the pinned key id, wrong key
    const home = join(work, 'home5'); mkdirSync(home);
    expect((await run(INSTALL, ['--base-url', url(), '--no-service'], home)).code).toBe(1);
    load(rel.dir); // genuine again, but the dev key without BOTWARREN_UPDATE_ALLOW_DEV_KEY
    const r = await run(INSTALL, ['--base-url', url(), '--no-service'], home, { BOTWARREN_UPDATE_ALLOW_DEV_KEY: '0' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/dev_key_refused/);
    expect(existsSync(join(home, '.local', 'share', 'botwarren'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('install.sh without a release server', () => {
  const home = () => { const h = mkTmp(); return h; };
  it('--dry-run changes and downloads nothing; non-https bases and odd directories are refused', () => {
    const h = home();
    const dry = spawnSync('sh', [INSTALL, '--dry-run', '--no-service'], { env: { PATH: process.env.PATH ?? '', HOME: h }, encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('dry run');
    expect(readdirSync(h)).toEqual([]);
    expect(spawnSync('sh', [INSTALL, '--base-url', 'http://evil.example.com'], { env: { PATH: process.env.PATH ?? '', HOME: h }, encoding: 'utf8' }).status).toBe(1);
    expect(spawnSync('sh', [INSTALL, '--install-dir', '/tmp/a;rm -rf x', '--dry-run'], { env: { PATH: process.env.PATH ?? '', HOME: h }, encoding: 'utf8' }).status).toBe(1);
    expect(spawnSync('sh', [INSTALL, '--bogus'], { env: { PATH: process.env.PATH ?? '', HOME: h }, encoding: 'utf8' }).status).toBe(2);
    rmTmp(h);
  });

  it('service definitions: systemd is a per-user unit (no root, restart on failure, no new privileges); the launchd plist is valid XML and runs the launcher', () => {
    const h = home();
    const svc = (kind: string) => spawnSync('sh', [INSTALL, `--print-service=${kind}`, '--install-dir', '/home/u/.local/share/botwarren'], { env: { PATH: process.env.PATH ?? '', HOME: h }, encoding: 'utf8' }).stdout;
    const unit = svc('systemd');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('NoNewPrivileges=yes');
    expect(unit).toContain('ExecStart="/home/u/.local/share/botwarren/runtime/node/node"');
    expect(unit).toContain('launcher.mjs" run');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/User=|sudo|WantedBy=multi-user/);
    const plist = svc('launchd');
    const parsed = spawnSync('python3', ['-I', '-c', 'import plistlib,sys,json; d=plistlib.loads(sys.stdin.buffer.read()); print(json.dumps(d))'], { input: plist, encoding: 'utf8' });
    expect(parsed.status).toBe(0);
    const d = JSON.parse(parsed.stdout);
    expect(d.Label).toBe('com.turbokast.botwarren');
    expect(d.ProgramArguments.slice(-2)).toEqual(['/home/u/.local/share/botwarren/launcher/launcher.mjs', 'run']);
    expect(d.RunAtLoad).toBe(true); expect(d.KeepAlive).toBe(true);
    expect(svc('autostart')).toContain('Exec=env BOTWARREN_HOME=');
    rmTmp(h);
  });
});
