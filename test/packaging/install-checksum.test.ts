/**
 * Checksum-verified install, for releases WITHOUT a signed update manifest (the situation until the production release key exists).
 * Needs no signing key, so unlike install-e2e.test.ts it runs on CI. It builds real releases with `noManifest` (archives, SHA256SUMS,
 * installers), serves them the way R2 will (`/latest.txt`, `/<version>/SHA256SUMS`, `/<version>/<archive>`) from a local HTTP server
 * and runs the REAL installers:
 *   - install.sh with `--checksum-only` (macOS and Linux)
 *   - install.ps1 with BOTWARREN_CHECKSUM_ONLY=1 (Windows PowerShell or PowerShell 7; also runs on Linux/macOS with pwsh, where the
 *     Windows-only steps (Scheduled Task, ACLs, user PATH) are skipped by the installer itself). Skipped when no PowerShell exists.
 * The runtime in the archives is a stub (a shell script that execs the node running the tests; on Windows a placeholder node.exe,
 * which the checksum mode never runs), so no 40 MB download.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeZip } from '../../src/update/archive.ts';
// @ts-expect-error plain JS module without types
import { buildRelease } from '../../scripts/build-release.mjs';
import { mkTmp, rmTmp } from '../update/kit.ts';

// PowerShell takes a few seconds to start, and a Windows runner is slower still
vi.setConfig({ testTimeout: 180_000 });

const ROOT = resolve(import.meta.dirname, '../..');
const INSTALL_SH = join(ROOT, 'packaging', 'install.sh');
const INSTALL_PS1 = join(ROOT, 'packaging', 'install.ps1');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const isWin = process.platform === 'win32';

/** the PowerShell to test with: BOTWARREN_TEST_PWSH, else pwsh, else Windows PowerShell; null when there is none */
const POWERSHELL: string | null = (() => {
  if (process.env.BOTWARREN_TEST_NO_POWERSHELL === '1') return null;
  for (const c of [process.env.BOTWARREN_TEST_PWSH, 'pwsh', 'powershell'].filter((x): x is string => !!x)) {
    // it must really run a command (an emulator's stub that exits 0 without running anything is not PowerShell)
    try { const r = spawnSync(c, ['-NoProfile', '-NonInteractive', '-Command', "Write-Output ('bw-ps-' + (1 + 1))"], { encoding: 'utf8', timeout: 60_000 }); if (r.status === 0 && r.stdout.includes('bw-ps-2')) return c; } catch { /* next */ }
  }
  return null;
})();

const unixTarget = `${process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const winTargets = ['win-x64', 'win-arm64'];

let work: string; let server: Server; let port: number;
const builds: Built[] = [];
const served = new Map<string, Buffer>(); // url path (no leading slash) -> bytes
const url = () => `http://127.0.0.1:${port}`;
const stubSh = () => ({ bin: { name: 'node', data: Buffer.from(`#!/bin/sh\nexec "${process.execPath}" "$@"\n`), mode: 0o755 }, license: null, archiveSha256: 'x' });
const stubExe = () => ({ bin: { name: 'node.exe', data: Buffer.from('MZ placeholder: the checksum mode never runs it'), mode: 0o755 }, license: null, archiveSha256: 'x' });

interface Built { version: string; dir: string; names: string[] }
async function build(version: string, targets: string[]): Promise<Built> {
  const runtimes = new Map(targets.map((t) => [t, t.startsWith('win') ? stubExe() : stubSh()]));
  const r = await buildRelease({ version, targets, out: join(work, `r-${version}`), runtimes, nodeVersion: '24.0.0', log: () => {}, env: {}, noManifest: true, commit: 'abcdef1' });
  return { version, dir: r.dir, names: readdirSync(r.dir) };
}
/** publish a built release the way the workflow does: <version>/<every file>, with latest.txt naming the newest */
function publish(b: Built, latest: boolean): void {
  for (const n of b.names) served.set(`${b.version}/${n}`, readFileSync(join(b.dir, n)));
  if (latest) served.set('latest.txt', Buffer.from(`${b.version}\n`));
}
const archiveName = (version: string, target: string) => `botwarren-${version}-${target}.${target.startsWith('win') ? 'zip' : 'tar.gz'}`;

beforeAll(async () => {
  work = mkTmp();
  const a = await build('0.5.0', [unixTarget, ...winTargets]);
  const b = await build('0.5.1', [unixTarget, ...winTargets]);
  builds.push(a, b);
  resetServed();
  server = createServer((req, res) => {
    const body = served.get((req.url ?? '').slice(1));
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); // like R2 does for a file without a known extension
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
}, 120_000);
afterAll(async () => { if (server) await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); if (work) rmTmp(work); });

/** restore the served files after a test tampered with them */
function resetServed(): void {
  for (const b of builds) publish(b, false);
  served.set('latest.txt', Buffer.from('0.5.1\n'));
}

/** ASYNC on purpose: the release server lives in this process, so a synchronous spawn would deadlock it. */
function exec(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolveP) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); }); p.stderr.on('data', (c: Buffer) => { out += c.toString(); });
    const t = setTimeout(() => p.kill('SIGKILL'), 120_000);
    p.on('exit', (code) => { clearTimeout(t); resolveP({ code, out }); });
  });
}
const newHome = (): string => { const h = mkTmp(); mkdirSync(join(h, 'tmp')); return h; };

describe.skipIf(isWin)('install.sh --checksum-only (no signed manifest)', () => {
  const sh = (home: string, args: string[], env: Record<string, string> = {}) =>
    exec('sh', [INSTALL_SH, '--base-url', url(), '--no-service', ...args], { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: join(home, 'tmp'), ...env });
  const rootOf = (home: string) => join(home, '.local', 'share', 'botwarren');

  it('installs an explicit version after checking SHA256SUMS, and says that auto-update is disabled', async () => {
    resetServed();
    const home = newHome();
    const r = await sh(home, ['--checksum-only', '--version', '0.5.0']);
    expect(r.out).toContain('checksum ok');
    expect(r.out).toMatch(/no signed release manifest was checked/);
    expect(r.out).toMatch(/Auto-update is DISABLED/);
    expect(r.code).toBe(0);
    const root = rootOf(home);
    for (const f of ['runtime/node/node', 'launcher/launcher.mjs', 'versions/0.5.0/agent.mjs', 'versions/0.5.0/cli.mjs', 'current.json', 'uninstall.sh', 'state/install-receipt.json']) expect(existsSync(join(root, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'))).toMatchObject({ version: '0.5.0', state: 'stable' });
    expect(JSON.parse(readFileSync(join(root, 'state', 'install-receipt.json'), 'utf8'))).toMatchObject({ method: 'standalone', verification: 'sha256sums', version: '0.5.0' });
    const v = spawnSync(join(home, '.local', 'bin', 'botwarren'), ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } });
    expect(v.stdout).toMatch(/\d+\.\d+\.\d+/); // the fixture is labelled 0.5.0; the bundled agent reports its own version
    rmTmp(home);
  });

  it('without a version it installs the newest one named in latest.txt (also with --version latest)', async () => {
    resetServed();
    for (const args of [['--checksum-only'], ['--checksum-only', '--version', 'latest']]) {
      const home = newHome();
      const r = await sh(home, args);
      expect(r.code, r.out).toBe(0);
      expect(JSON.parse(readFileSync(join(rootOf(home), 'current.json'), 'utf8')).version).toBe('0.5.1');
      rmTmp(home);
    }
  });

  it('BOTWARREN_CHECKSUM_ONLY=1 is the same as the flag, and the dry run says which verification will be used', async () => {
    resetServed();
    const home = newHome();
    const dry = await sh(home, ['--dry-run'], { BOTWARREN_CHECKSUM_ONLY: '1' });
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/verification: SHA256SUMS over HTTPS only .*DISABLED/);
    expect((await sh(home, ['--dry-run'])).out).toContain('verification: signed release manifest');
    expect((await sh(home, ['--dry-run', '--checksum-only'])).out).toMatch(/SHA256SUMS over HTTPS only/);
    rmTmp(home);
  });

  it('the installed updater stays inert: with no signed manifest a manual update changes nothing and runs no code', async () => {
    resetServed();
    const home = newHome();
    expect((await sh(home, ['--checksum-only', '--version', '0.5.0'])).code).toBe(0);
    const env = { PATH: process.env.PATH ?? '', HOME: home, BOTWARREN_UPDATE_URL: `${url()}/` };
    const before = readFileSync(join(rootOf(home), 'current.json'), 'utf8');
    const r = await exec(join(home, '.local', 'bin', 'botwarren'), ['update'], env); // async: the server is in this process
    expect(r.out).toMatch(/Nothing was changed/); // no manifest to fetch: nothing signed, so nothing runs
    expect(readFileSync(join(rootOf(home), 'current.json'), 'utf8')).toBe(before);
    expect(readdirSync(join(rootOf(home), 'versions'))).toEqual(['0.5.0']);
    rmTmp(home);
  });

  it('REFUSES a tampered archive and installs nothing', async () => {
    resetServed();
    const key = `0.5.0/${archiveName('0.5.0', unixTarget)}`;
    const evil = Buffer.from(served.get(key)!); evil[evil.length - 40]! ^= 0xff;
    served.set(key, evil);
    const home = newHome();
    const r = await sh(home, ['--checksum-only', '--version', '0.5.0']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/checksum mismatch/);
    expect(existsSync(rootOf(home))).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'botwarren'))).toBe(false);
    rmTmp(home); resetServed();
  });

  it('REFUSES when SHA256SUMS does not list the archive, has a malformed hash, or cannot be downloaded', async () => {
    const name = archiveName('0.5.0', unixTarget);
    const home = newHome();
    served.set('0.5.0/SHA256SUMS', Buffer.from(`${'0'.repeat(64)}  something-else.tar.gz\n`));
    let r = await sh(home, ['--checksum-only', '--version', '0.5.0']);
    expect(r.code).toBe(1); expect(r.out).toMatch(/does not list/);
    served.set('0.5.0/SHA256SUMS', Buffer.from(`not-a-hash  ${name}\n`));
    r = await sh(home, ['--checksum-only', '--version', '0.5.0']);
    expect(r.code).toBe(1); expect(r.out).toMatch(/bad checksum/);
    served.delete('0.5.0/SHA256SUMS');
    r = await sh(home, ['--checksum-only', '--version', '0.5.0']);
    expect(r.code).toBe(1); expect(r.out).toMatch(/could not download/);
    expect(existsSync(rootOf(home))).toBe(false);
    rmTmp(home); resetServed();
  });

  it('REFUSES an archive with unsafe paths even when its hash is listed (the checksum alone does not make content safe)', async () => {
    const d = mkTmp();
    const py = ['-I', '-c', 'import tarfile,io,sys; t=tarfile.open(sys.argv[1],"w:gz"); i=tarfile.TarInfo("../evil.txt"); b=b"x"; i.size=len(b); t.addfile(i, io.BytesIO(b)); t.close()', join(d, 'evil.tar.gz')];
    expect(spawnSync('python3', py).status).toBe(0);
    const evil = readFileSync(join(d, 'evil.tar.gz'));
    const name = archiveName('0.5.0', unixTarget);
    served.set(`0.5.0/${name}`, evil);
    served.set('0.5.0/SHA256SUMS', Buffer.from(`${sha(evil)}  ${name}\n`));
    const home = newHome();
    const r = await sh(home, ['--checksum-only', '--version', '0.5.0']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/unsafe paths/);
    expect(existsSync(rootOf(home))).toBe(false);
    rmTmp(home); rmTmp(d); resetServed();
  });

  it('refuses a malformed version, and a hostile latest.txt', async () => {
    const home = newHome();
    for (const v of ['1.2', '../../etc', '1.2.3;rm', '1..2']) {
      const r = await sh(home, ['--checksum-only', '--version', v]);
      expect(r.code, v).not.toBe(0);
    }
    for (const bad of ['../../../etc/passwd\n', '0.5.0/../1\n', 'latest\n', '']) {
      served.set('latest.txt', Buffer.from(bad));
      const r = await sh(home, ['--checksum-only']);
      expect(r.code, JSON.stringify(bad)).toBe(1);
    }
    expect(existsSync(rootOf(home))).toBe(false);
    rmTmp(home); resetServed();
  });

  it('without --checksum-only and without a signed manifest it refuses, installs nothing, and says how to ask for the checksum mode', async () => {
    resetServed();
    const home = newHome();
    const r = await sh(home, []);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no signed update manifest/);
    expect(r.out).toContain('--checksum-only');
    expect(existsSync(rootOf(home))).toBe(false);
    rmTmp(home);
  });
});

describe.skipIf(!POWERSHELL)('install.ps1 with BOTWARREN_CHECKSUM_ONLY=1 (no signed manifest)', () => {
  const ps = async (home: string, env: Record<string, string> = {}) => {
    const local = join(home, 'AppData', 'Local');
    // PowerShell wraps long error lines to the console width: compare with whitespace collapsed
    const r = await exec(POWERSHELL!, ['-NoProfile', '-NonInteractive', '-File', INSTALL_PS1], {
      ...(process.env as Record<string, string>),
      HOME: home, USERPROFILE: home, LOCALAPPDATA: local, APPDATA: join(home, 'AppData', 'Roaming'), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp'),
      BOTWARREN_BASE_URL: url(), BOTWARREN_NO_TASK: '1', BOTWARREN_NO_PATH: '1', BOTWARREN_INSTALL_DIR: join(local, 'Botwarren'), ...env,
    });
    return { code: r.code, out: r.out.replace(/\s+/g, ' ') };
  };
  const rootOf = (home: string) => join(home, 'AppData', 'Local', 'Botwarren');
  const target = (): string => {
    // the installer derives the target from the CPU, like the shell one
    return process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
  };

  it('installs an explicit version after checking SHA256SUMS, writes the receipt, and says that auto-update is disabled', async () => {
    resetServed();
    const home = newHome();
    const r = await ps(home, { BOTWARREN_CHECKSUM_ONLY: '1', BOTWARREN_VERSION: '0.5.0' });
    expect(r.out).toContain('checksum ok');
    expect(r.out).toMatch(/no signed release manifest was checked/);
    expect(r.out).toMatch(/Auto-update is DISABLED/);
    expect(r.code, r.out).toBe(0);
    const root = rootOf(home);
    for (const f of ['runtime/node/node.exe', 'runtime/NODE_VERSION', 'launcher/launcher.mjs', 'versions/0.5.0/agent.mjs', 'versions/0.5.0/cli.mjs', 'versions/0.5.0/ops.html', 'current.json', 'uninstall.ps1', 'state/install-receipt.json', 'bin/botwarren.cmd']) expect(existsSync(join(root, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'current.json'), 'utf8').replace(/^\uFEFF/, ''))).toMatchObject({ version: '0.5.0', state: 'stable', knownGood: '0.5.0' });
    expect(JSON.parse(readFileSync(join(root, 'state', 'install-receipt.json'), 'utf8').replace(/^\uFEFF/, ''))).toMatchObject({ method: 'standalone', verification: 'sha256sums', version: '0.5.0' });
    const cmd = readFileSync(join(root, 'bin', 'botwarren.cmd'), 'latin1');
    expect(cmd).toContain('\r\n'); // a .cmd file needs CRLF
    expect(cmd).toContain('launcher.mjs');
    expect(readdirSync(join(home, 'tmp')).filter((n) => n.startsWith('botwarren-install-'))).toEqual([]); // the temp folder is removed
    rmTmp(home);
  });

  it('without a version it installs the newest one named in latest.txt', async () => {
    resetServed();
    const home = newHome();
    const r = await ps(home, { BOTWARREN_CHECKSUM_ONLY: '1' });
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(readFileSync(join(rootOf(home), 'current.json'), 'utf8').replace(/^\uFEFF/, '')).version).toBe('0.5.1');
    rmTmp(home);
  });

  it('upgrading over an installed version starts the new one in TRIAL and keeps the old one', async () => {
    resetServed();
    const home = newHome();
    expect((await ps(home, { BOTWARREN_CHECKSUM_ONLY: '1', BOTWARREN_VERSION: '0.5.0' })).code).toBe(0);
    const r = await ps(home, { BOTWARREN_CHECKSUM_ONLY: '1', BOTWARREN_VERSION: '0.5.1' });
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(readFileSync(join(rootOf(home), 'current.json'), 'utf8').replace(/^\uFEFF/, ''))).toMatchObject({ version: '0.5.1', previous: '0.5.0', knownGood: '0.5.0', state: 'trial' });
    expect(readdirSync(join(rootOf(home), 'versions')).sort()).toEqual(['0.5.0', '0.5.1']);
    rmTmp(home);
  });

  it('REFUSES a tampered archive and installs nothing', async () => {
    resetServed();
    const key = `0.5.0/${archiveName('0.5.0', target())}`;
    const evil = Buffer.from(served.get(key)!); evil[evil.length - 40]! ^= 0xff;
    served.set(key, evil);
    const home = newHome();
    const r = await ps(home, { BOTWARREN_CHECKSUM_ONLY: '1', BOTWARREN_VERSION: '0.5.0' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/checksum mismatch/);
    expect(existsSync(rootOf(home))).toBe(false);
    rmTmp(home); resetServed();
  });

  it('REFUSES when SHA256SUMS does not list the archive, or the version is malformed, or latest.txt is hostile', async () => {
    const home = newHome();
    served.set('0.5.0/SHA256SUMS', Buffer.from(`${'0'.repeat(64)}  something-else.zip\n`));
    let r = await ps(home, { BOTWARREN_CHECKSUM_ONLY: '1', BOTWARREN_VERSION: '0.5.0' });
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/does not list/);
    resetServed();
    r = await ps(home, { BOTWARREN_CHECKSUM_ONLY: '1', BOTWARREN_VERSION: '1.2;calc' });
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/must look like 1\.2\.3/);
    served.set('latest.txt', Buffer.from('..\\..\\evil\n'));
    r = await ps(home, { BOTWARREN_CHECKSUM_ONLY: '1' });
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/bad version/);
    expect(existsSync(rootOf(home))).toBe(false);
    rmTmp(home); resetServed();
  });

  it('REFUSES an archive with unsafe paths even when its hash is listed', async () => {
    const evil = writeZip([{ name: 'runtime/node/node.exe', data: Buffer.from('x'), mode: 0o644 }]);
    // writeZip validates names, so splice a hostile name into a valid archive's bytes (same length: no offsets change)
    const bad = Buffer.from(evil.toString('latin1').split('runtime/node/node.exe').join('runtime/../../abc.exe'), 'latin1');
    const name = archiveName('0.5.0', target());
    served.set(`0.5.0/${name}`, bad);
    served.set('0.5.0/SHA256SUMS', Buffer.from(`${sha(bad)}  ${name}\n`));
    const home = newHome();
    const r = await ps(home, { BOTWARREN_CHECKSUM_ONLY: '1', BOTWARREN_VERSION: '0.5.0' });
    expect(r.code, r.out).not.toBe(0);
    expect(r.out, r.out).toMatch(/unsafe paths/);
    expect(existsSync(rootOf(home))).toBe(false);
    rmTmp(home); resetServed();
  });

  it('without BOTWARREN_CHECKSUM_ONLY and without a signed manifest it refuses, installs nothing, and says how to ask for the checksum mode', async () => {
    resetServed();
    const home = newHome();
    const r = await ps(home);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/no signed update manifest/);
    expect(r.out).toContain('BOTWARREN_CHECKSUM_ONLY=1');
    expect(existsSync(rootOf(home))).toBe(false);
    rmTmp(home);
  });

  it('the dry run changes nothing and names the verification in use; a non-https base is refused', async () => {
    const home = newHome();
    const dry = await ps(home, { BOTWARREN_CHECKSUM_ONLY: '1', BOTWARREN_DRY_RUN: '1' });
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toMatch(/SHA256SUMS over HTTPS only/);
    expect(existsSync(rootOf(home))).toBe(false);
    const bad = await ps(home, { BOTWARREN_BASE_URL: 'http://evil.example.com', BOTWARREN_CHECKSUM_ONLY: '1' });
    expect(bad.code).not.toBe(0);
    expect(bad.out).toMatch(/must be https/);
    rmTmp(home);
  });
});

describe('the same layout is what both installers expect', () => {
  it('a published release has <version>/SHA256SUMS listing exactly the archive names the installers derive', () => {
    resetServed();
    for (const t of [unixTarget, ...winTargets]) {
      const sums = served.get('0.5.0/SHA256SUMS')!.toString();
      const line = sums.split('\n').find((l) => l.endsWith(`  ${archiveName('0.5.0', t)}`));
      expect(line, t).toBeDefined();
      expect(line!.split('  ')[0]).toBe(sha(served.get(`0.5.0/${archiveName('0.5.0', t)}`)!));
    }
  });
});
