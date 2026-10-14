/**
 * Zero-touch onboarding in the installers: the single-use claim code from botwarren.com/get (BOTWARREN_CLAIM / --claim).
 *  - its shape is checked before anything is downloaded, and it is NEVER printed, written to a file or service definition, or passed as an argument
 *  - a terminal install without a code ends in the device-code flow; a non-interactive one only points at the website
 *  - an existing setup is left alone; --no-connect installs only
 *  - uninstall is idempotent and says what it removed
 * Real Windows / macOS runs are UNVERIFIED (PowerShell is only checked statically here).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module without types
import { buildRelease } from '../../scripts/build-release.mjs';
import { mkTmp, rmTmp } from '../update/kit.ts';

vi.setConfig({ testTimeout: 120_000 });

const ROOT = resolve(import.meta.dirname, '../..');
const INSTALL_SH = join(ROOT, 'packaging', 'install.sh');
const UNINSTALL_SH = join(ROOT, 'packaging', 'uninstall.sh');
const read = (n: string) => readFileSync(join(ROOT, 'packaging', n), 'utf8');
const codeLines = (t: string) => t.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const isWin = process.platform === 'win32';
const unixTarget = `${process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

/** a claim code the way the server mints it: bwc_ + 43 url-safe characters */
const CLAIM = `bwc_${'Ab3-_Zk9Qw'.repeat(4)}xyz`;
const ENV = (home: string, extra: Record<string, string> = {}): Record<string, string> => ({ PATH: process.env.PATH ?? '', HOME: home, TMPDIR: join(home, 'tmp'), BOTWARREN_NONINTERACTIVE: '1', ...extra });

function exec(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolveP) => {
    const p = spawn('sh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); }); p.stderr.on('data', (c: Buffer) => { out += c.toString(); });
    const t = setTimeout(() => p.kill('SIGKILL'), 100_000);
    p.on('exit', (code) => { clearTimeout(t); resolveP({ code, out }); });
  });
}
const newHome = (): string => { const h = mkTmp(); mkdirSync(join(h, 'tmp')); return h; };
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe.skipIf(isWin)('install.sh claim code: shape, secrecy, dry run', () => {
  // an unreachable download host: anything that tries to download would fail with "could not download", not with a claim message
  const dead = ['--base-url', 'http://127.0.0.1:9'];

  it('refuses a cut-off or altered code BEFORE downloading anything, without echoing it', async () => {
    const home = newHome();
    for (const bad of ['bwc_short', `${CLAIM}!`, `${CLAIM} extra`, 'not-ours-0123456789012345678901', `bwc_${'a'.repeat(200)}`, 'bwc_']) {
      const r = await exec([INSTALL_SH, ...dead, '--no-service'], ENV(home, { BOTWARREN_CLAIM: bad }));
      expect(r.code, bad).toBe(1);
      expect(r.out, bad).toMatch(/looks cut off/);
      expect(r.out, bad).toContain('https://botwarren.com/get');
      expect(r.out, bad).not.toContain(bad);
      expect(r.out, bad).not.toMatch(/could not download/);
    }
    expect(readdirSync(home)).toEqual(['tmp']);
    rmTmp(home);
  });

  it('a good code (env or --claim) passes validation; the dry run changes nothing and never prints it', async () => {
    const home = newHome();
    for (const [args, env] of [[[], { BOTWARREN_CLAIM: CLAIM }], [['--claim', CLAIM], {}]] as [string[], Record<string, string>][]) {
      const r = await exec([INSTALL_SH, ...dead, '--no-service', '--dry-run', ...args], ENV(home, env));
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('dry run');
      expect(r.out).toMatch(/connect\s+: with your single-use claim code \(not shown\)/);
      expect(r.out).not.toContain(CLAIM); expect(r.out).not.toContain(CLAIM.slice(4, 24));
    }
    const off = await exec([INSTALL_SH, ...dead, '--no-service', '--dry-run', '--no-connect'], ENV(home, { BOTWARREN_CLAIM: CLAIM }));
    expect(off.out).toMatch(/connect\s+: no \(--no-connect\)/);
    expect(readdirSync(home)).toEqual(['tmp']);
    rmTmp(home);
  });

  it('--claim needs a value', async () => {
    const home = newHome();
    const r = await exec([INSTALL_SH, ...dead, '--claim'], ENV(home));
    expect(r.code).toBe(2);
    rmTmp(home);
  });

  it('no service definition (systemd, launchd, autostart) can contain the code, even when it is in the environment', () => {
    const home = newHome();
    for (const kind of ['systemd', 'launchd', 'autostart']) {
      const r = spawnSync('sh', [INSTALL_SH, `--print-service=${kind}`, '--install-dir', '/home/u/.local/share/botwarren'], { env: ENV(home, { BOTWARREN_CLAIM: CLAIM }), encoding: 'utf8' });
      expect(r.status, kind).toBe(0);
      expect(r.stdout, kind).not.toContain(CLAIM); expect(r.stdout, kind).not.toMatch(/BOTWARREN_CLAIM|bwc_/);
    }
    rmTmp(home);
  });

  it('--help documents the code, the environment form and the exit code', () => {
    const r = spawnSync('sh', [INSTALL_SH, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    for (const w of ['BOTWARREN_CLAIM', '--claim', '--no-connect', '--non-interactive', 'single-use', 'Exit codes']) expect(r.stdout, w).toContain(w);
    expect(r.stdout).not.toContain('set -eu');
  });
});

describe('static checks: the code is never an argument, a file, a unit or output, and nothing needs sudo or admin', () => {
  it('install.sh', () => {
    const t = read('install.sh'); const code = codeLines(t);
    expect(code).toContain('unset BOTWARREN_CLAIM');
    expect(code).toMatch(/BOTWARREN_CLAIM="\$CLAIM" "\$BIN_DIR\/botwarren" connect <\/dev\/null/); // only the environment of that one process
    expect(code).not.toMatch(/connect\s+(?:-\S+\s+)*"?\$\{?CLAIM|connect\s+--claim/); // not an argument
    expect(code).not.toMatch(/\b(say|printf|echo)\s+"[^"\n]*\$\{?CLAIM/); // never printed
    expect(code).not.toMatch(/>\s*"?[^\n]*\$\{?CLAIM|CLAIM[^\n]*>>?\s*"?\$/); // never redirected into a file
    expect(code).not.toMatch(/\bsudo\b|\bsu -c\b|\bdoas\b|pkexec/);
    expect(code.indexOf('looks cut off')).toBeLessThan(code.indexOf('step "Looking up the release"')); // validated before any download
    expect(code.indexOf('register_service; fi')).toBeLessThan(code.indexOf('  connect_step\n')); // connect only after the service is registered
  });

  it('install.ps1', () => {
    const t = read('install.ps1'); const code = codeLines(t);
    expect(code).toMatch(/Remove-Item Env:\\BOTWARREN_CLAIM/);
    expect(code).toContain("notmatch '^bwc_[A-Za-z0-9_-]{20,80}$'");
    expect(code.indexOf('looks cut off')).toBeLessThan(code.indexOf("Write-Step 'Looking up the release'"));
    expect(code).toMatch(/\$env:BOTWARREN_CLAIM = \$Claim\s*\n\s*try \{ & \$botwarren connect;/); // env only, then dropped in the finally
    expect(code).not.toMatch(/connect\s+(?:-\S+\s+)*\$Claim|connect\s+--claim/); // not an argument
    expect(code).not.toMatch(/Write-Host\s+(?:"[^"\n]*)?\$Claim|Out-File[^\n]*\$Claim|Set-Content[^\n]*\$Claim|WriteAllText[^\n]*\$Claim/);
    expect(code).not.toMatch(/runas|-Verb\s+RunAs|RunLevel Highest|Start-Process[^\n]*-Verb/i);
    expect(code.indexOf("Register-ScheduledTask")).toBeLessThan(code.indexOf('$env:BOTWARREN_CLAIM = $Claim'));
    // the scheduled task never carries it
    const task = code.split('\n').filter((l) => /ScheduledTask/.test(l)).join('\n');
    expect(task).not.toMatch(/Claim|BOTWARREN_CLAIM/);
    expect(t).not.toMatch(/[^\x09\x0a\x0d\x20-\x7e]/); // eslint-disable-line no-control-regex
  });

  it('uninstall scripts: no elevation, report what they remove, safe to repeat', () => {
    for (const f of ['uninstall.sh', 'uninstall.ps1']) {
      const code = codeLines(read(f));
      expect(code, f).not.toMatch(/\bsudo\b|runas|-Verb\s+RunAs|RunLevel Highest|HKLM/i);
      expect(code, f).toMatch(/Nothing to remove/);
      expect(code, f).toMatch(/removed /);
    }
    expect(codeLines(read('uninstall.ps1'))).toMatch(/botwarren-uninstall-/); // continues from a temp copy: a script cannot delete the folder it runs from
  });
});

// ---------------------------------------------------------------------------- real installs from a local release server
describe.skipIf(isWin)('install.sh end to end: what happens after the files are in place', () => {
  let work: string; let server: Server; let port: number;
  const served = new Map<string, Buffer>();
  const base = () => `http://127.0.0.1:${port}`;
  const stubSh = () => ({ bin: { name: 'node', data: Buffer.from(`#!/bin/sh\nexec "${process.execPath}" "$@"\n`), mode: 0o755 }, license: null, archiveSha256: 'x' });

  beforeAll(async () => {
    work = mkTmp();
    const r = await buildRelease({ version: '0.5.0', targets: [unixTarget], out: join(work, 'r'), runtimes: new Map([[unixTarget, stubSh()]]), nodeVersion: '24.0.0', log: () => {}, env: {}, noManifest: true, commit: 'abcdef1' });
    for (const n of readdirSync(r.dir)) served.set(`0.5.0/${n}`, readFileSync(join(r.dir, n)));
    served.set('latest.txt', Buffer.from('0.5.0\n'));
    server = createServer((req, res) => {
      const body = served.get((req.url ?? '').slice(1));
      if (!body) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(body);
    });
    await new Promise<void>((r2) => server.listen(0, '127.0.0.1', r2));
    port = (server.address() as { port: number }).port;
  }, 120_000);
  afterAll(async () => { if (server) await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); if (work) rmTmp(work); });

  // never talks to botwarren.com: a pair/connect attempt would go to a closed local port
  const install = (home: string, args: string[], env: Record<string, string> = {}) =>
    exec([INSTALL_SH, '--base-url', base(), '--no-service', '--checksum-only', '--version', '0.5.0', ...args], ENV(home, { BOTWARREN_SITE_URL: 'http://127.0.0.1:9', ...env }));
  const cfgFile = (home: string) => join(home, '.config', 'botwarren-ship', 'config.json');

  it('no code and no terminal: it only points at the website (and never starts a device-code flow)', async () => {
    const home = newHome();
    const r = await install(home, []);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Open https://botwarren.com/get to connect this computer.');
    expect(r.out).not.toMatch(/botwarren pair/);
    expect(r.out).toMatch(/botwarren uninstall/); expect(r.out).toContain('uninstall.sh'); expect(r.out).toMatch(/botwarren status/);
    expect(existsSync(cfgFile(home))).toBe(false);
    rmTmp(home);
  });

  it('--no-connect and BOTWARREN_NO_CONNECT=1 install only, even with a code', async () => {
    const home = newHome();
    for (const [args, env] of [[['--no-connect'], { BOTWARREN_CLAIM: CLAIM }], [[], { BOTWARREN_NO_CONNECT: '1', BOTWARREN_CLAIM: CLAIM }]] as [string[], Record<string, string>][]) {
      const r = await install(home, args, env);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('Not connected');
      expect(r.out).not.toContain('Connecting this computer');
      expect(r.out).not.toContain(CLAIM);
    }
    rmTmp(home);
  });

  it('an existing setup is kept and not reconnected when there is no code', async () => {
    const home = newHome();
    mkdirSync(join(home, '.config', 'botwarren-ship'), { recursive: true });
    writeFileSync(cfgFile(home), '{"shipId":"keep-me"}\n');
    const r = await install(home, []);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Your existing setup was kept');
    expect(r.out).not.toContain('Open https://botwarren.com/get');
    expect(readFileSync(cfgFile(home), 'utf8')).toBe('{"shipId":"keep-me"}\n');
    rmTmp(home);
  });

  it('with a code the connect step runs; when it cannot succeed the install stands, the exit code says so, and the code is nowhere', async () => {
    const home = newHome();
    const r = await install(home, [], { BOTWARREN_CLAIM: CLAIM });
    expect(r.out).toContain('Connecting this computer to your ship');
    expect(existsSync(join(home, '.local', 'share', 'botwarren', 'current.json'))).toBe(true); // installed
    expect(r.out).toMatch(/Botwarren 0\.5\.0 is installed\./);
    // the stub release has no working cloud to claim against: either the CLI does not know `connect` yet or the site is unreachable
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain('could not be connected');
    expect(r.out).toContain('https://botwarren.com/get');
    expect(r.out).not.toContain(CLAIM);
    for (const f of filesUnder(home)) expect(readFileSync(f).toString('latin1'), f).not.toContain(CLAIM);
    rmTmp(home);
  });

  it('uninstall is idempotent: the first run lists what it removed, the second finds nothing and is not an error', async () => {
    const home = newHome();
    expect((await install(home, ['--no-connect'])).code).toBe(0);
    const un = (extra: string[] = []) => exec([UNINSTALL_SH, '--yes', ...extra], ENV(home));
    const first = await un();
    expect(first.code, first.out).toBe(0);
    expect(first.out).toMatch(/removed .*\/\.local\/share\/botwarren\b/);
    expect(first.out).toMatch(/Removed \d+ item\(s\)\./);
    expect(first.out).toContain('Disconnect this computer');
    expect(existsSync(join(home, '.local', 'share', 'botwarren'))).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'botwarren'))).toBe(false);
    const second = await un();
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain('Nothing to remove');
    rmTmp(home);
  });
});
