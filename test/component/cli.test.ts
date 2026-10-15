/**
 * `botwarren companion pair|devices|...` passes through to the installed companion (and only to it, and only the allowlisted subcommands), and the
 * `botwarren-companion` shim next to `botwarren` does the same for the older spelling.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PASSTHROUGH, runCompanion } from '../../src/component/cli.ts';
import { componentPaths, recordConsent, setLocalBlock } from '../../src/component/install.ts';
import { SHIM_MARKER, ensureShim, removeShim, shimDir, shimText } from '../../src/component/shim.ts';
import { mkTmp, rmTmp } from '../update/kit.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

/** a data dir with an "installed" companion whose companion.mjs records its arguments */
function world(opts: { installed?: boolean } = {}) {
  const dir = mkTmp(); cleanup.push(() => rmTmp(dir));
  const root = join(dir, 'home'); const bin = join(dir, 'bin'); const record = join(dir, 'record.json');
  mkdirSync(bin, { recursive: true });
  const cfg = { dataDir: dir };
  const env = { BOTWARREN_HOME: root, BOTWARREN_BIN_DIR: bin, RECORD: record, PATH: process.env.PATH } as Record<string, string | undefined>;
  if (opts.installed !== false) {
    const P = componentPaths(root);
    mkdirSync(P.version('0.1.0'), { recursive: true });
    writeFileSync(join(P.version('0.1.0'), 'companion.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.RECORD, JSON.stringify(process.argv.slice(2))); process.exit(process.argv.includes('fail') ? 7 : 0);\n");
    writeFileSync(P.current, JSON.stringify({ version: '0.1.0', sha256: 'a'.repeat(64), installedAt: '2026-10-15T00:00:00.000Z', consentAt: '2026-10-15T00:00:00.000Z', keyId: 'k', manifestVersion: 1 }));
  }
  return { dir, root, bin, record, cfg, env };
}

const quiet = async <T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> => {
  let out = ''; let err = '';
  const so = process.stdout.write.bind(process.stdout); const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => { err += String(s); return true; }) as typeof process.stderr.write;
  try { return { result: await fn(), out, err }; } finally { process.stdout.write = so; process.stderr.write = se; }
};

describe('botwarren companion <command>: passthrough to the installed companion', () => {
  it('runs the verified component with the same arguments and returns its exit code (real process)', async () => {
    const w = world();
    expect(await runCompanion(w.cfg, ['pair'], { env: w.env })).toBe(0);
    expect(JSON.parse(readFileSync(w.record, 'utf8'))).toEqual(['pair']);
    expect(await runCompanion(w.cfg, ['claude', 'install-hooks', '--scope', 'user', 'fail'], { env: w.env })).toBe(7);
    expect(JSON.parse(readFileSync(w.record, 'utf8'))).toEqual(['claude', 'install-hooks', '--scope', 'user', 'fail']);
  });

  it('every documented subcommand passes through', async () => {
    const w = world(); const seen: string[][] = [];
    const exec = async (_e: string, a: string[]): Promise<number> => { seen.push(a); return 0; };
    for (const c of ['pair', 'devices', 'pause', 'resume', 'confirm', 'log', 'claude', 'version']) await runCompanion(w.cfg, [c, 'x'], { env: w.env, exec });
    expect(seen.map((a) => a[0])).toEqual([...PASSTHROUGH]);
  });

  it('refuses everything the agent or Claude Code runs itself, and `uninstall` (use remove), without running anything', async () => {
    const w = world(); let ran = 0;
    const exec = async (): Promise<number> => { ran++; return 0; };
    for (const c of ['daemon', 'init', 'enroll', 'hook', 'channel', 'uninstall', 'rm', '--version']) {
      const r = await quiet(() => runCompanion(w.cfg, [c], { env: w.env, exec }));
      expect(r.result, c).toBe(2);
    }
    expect(ran).toBe(0);
    const u = await quiet(() => runCompanion(w.cfg, ['uninstall'], { env: w.env, exec }));
    expect(u.err).toContain('botwarren companion remove');
  });

  it('not installed: says so and how it gets installed, runs nothing', async () => {
    const w = world({ installed: false }); let ran = 0;
    const exec = async (): Promise<number> => { ran++; return 0; };
    const a = await quiet(() => runCompanion(w.cfg, ['pair'], { env: w.env, exec }));
    expect(a.result).toBe(1); expect(a.err).toContain('not installed'); expect(a.err).toContain('https://botwarren.com/account');
    recordConsent(w.root, '2026-10-15T00:00:00.000Z', Date.now());
    const b = await quiet(() => runCompanion(w.cfg, ['pair'], { env: w.env, exec }));
    expect(b.result).toBe(1); expect(b.err).toContain('ship agent installs it');
    expect(ran).toBe(0);
  });

  it('blocked on this computer (file or environment): nothing runs', async () => {
    const w = world(); let ran = 0;
    const exec = async (): Promise<number> => { ran++; return 0; };
    setLocalBlock(w.root, true);
    expect((await quiet(() => runCompanion(w.cfg, ['pair'], { env: w.env, exec }))).result).toBe(1);
    setLocalBlock(w.root, false);
    expect((await quiet(() => runCompanion(w.cfg, ['pair'], { env: { ...w.env, BOTWARREN_DISABLE_COMPONENTS: '1' }, exec }))).result).toBe(1);
    expect(ran).toBe(0);
  });

  it('status shows the install and then the companion\'s own status; remove deletes the files and the shim', async () => {
    const w = world(); const seen: string[][] = [];
    writeFileSync(join(w.bin, 'botwarren'), '#!/bin/sh\n');
    const exec = async (_e: string, a: string[]): Promise<number> => { seen.push(a); return 0; };
    const s = await quiet(() => runCompanion(w.cfg, ['status'], { env: w.env, exec }));
    expect(s.out).toContain('installed: yes, version 0.1.0'); expect(s.out).toContain('botwarren companion pair');
    expect(seen).toEqual([['status']]);
    // a passthrough repairs a missing shim
    await runCompanion(w.cfg, ['devices'], { env: w.env, exec });
    expect(existsSync(join(w.bin, 'botwarren-companion'))).toBe(true);
    const r = await quiet(() => runCompanion(w.cfg, ['remove'], { env: w.env, exec }));
    expect(r.result).toBe(0);
    expect(existsSync(componentPaths(w.root).dir)).toBe(false);
    expect(existsSync(join(w.bin, 'botwarren-companion'))).toBe(false);
  });
});

describe('the botwarren-companion shim', () => {
  const tmpBin = () => { const d = mkTmp(); cleanup.push(() => rmTmp(d)); return d; };

  it('is written only next to a botwarren command, and only the same fixed text', () => {
    const bin = tmpBin(); const o = { env: { BOTWARREN_BIN_DIR: bin } };
    expect(ensureShim(o)).toBe('no_botwarren_command');
    expect(existsSync(join(bin, 'botwarren-companion'))).toBe(false);
    writeFileSync(join(bin, 'botwarren'), '#!/bin/sh\n');
    expect(ensureShim(o)).toBe('written');
    expect(readFileSync(join(bin, 'botwarren-companion'), 'utf8')).toBe(shimText(false));
    expect(ensureShim(o)).toBe('present');
    // it names no version, no path to the component and no URL
    expect(shimText(false)).not.toMatch(/https?:|versions|\.mjs|node/);
    expect(shimText(true)).not.toMatch(/https?:|versions|\.mjs|node/);
  });

  it('never overwrites or removes a file this agent did not write', () => {
    const bin = tmpBin(); const o = { env: { BOTWARREN_BIN_DIR: bin } };
    writeFileSync(join(bin, 'botwarren'), '#!/bin/sh\n');
    writeFileSync(join(bin, 'botwarren-companion'), '#!/bin/sh\necho mine\n');
    expect(ensureShim(o)).toBe('foreign_file');
    expect(removeShim(o)).toBe(false);
    expect(readFileSync(join(bin, 'botwarren-companion'), 'utf8')).toContain('echo mine');
  });

  it('updates its own older text and is removed with the component', () => {
    const bin = tmpBin(); const o = { env: { BOTWARREN_BIN_DIR: bin } };
    writeFileSync(join(bin, 'botwarren'), '#!/bin/sh\n');
    writeFileSync(join(bin, 'botwarren-companion'), `#!/bin/sh\n# ${SHIM_MARKER}: old\nexit 1\n`);
    expect(ensureShim(o)).toBe('written');
    expect(removeShim(o)).toBe(true);
    expect(existsSync(join(bin, 'botwarren-companion'))).toBe(false);
  });

  it('puts it where the installers put `botwarren` (Linux and macOS ~/.local/bin; Windows <install dir>\\bin)', () => {
    expect(shimDir({ os: 'linux', home: '/home/a', env: {} })).toBe(join('/home/a', '.local', 'bin'));
    expect(shimDir({ os: 'darwin', home: '/Users/a', env: {} })).toBe(join('/Users/a', '.local', 'bin'));
    expect(shimDir({ os: 'win32', home: 'C:\\Users\\a', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } })).toBe(join('C:\\Users\\a\\AppData\\Local', 'Botwarren', 'bin'));
    expect(shimDir({ os: 'win32', env: { BOTWARREN_HOME: 'D:\\bw' } })).toBe(join('D:\\bw', 'bin'));
    expect(shimDir({ os: 'linux', env: { BOTWARREN_BIN_DIR: '/opt/bin' } })).toBe('/opt/bin');
    const cmd = shimText(true);
    expect(cmd).toContain('\r\n');
    expect(cmd).toContain('call "%~dp0botwarren.cmd" companion %*');
    expect(cmd).toContain('exit /b %ERRORLEVEL%');
  });

  it.skipIf(process.platform === 'win32')('running the shim runs `botwarren companion <the same arguments>`', () => {
    const bin = tmpBin(); const o = { env: { BOTWARREN_BIN_DIR: bin } };
    writeFileSync(join(bin, 'botwarren'), '#!/bin/sh\nprintf "%s|" "$@"\n'); chmodSync(join(bin, 'botwarren'), 0o755);
    expect(ensureShim(o)).toBe('written');
    const r = spawnSync(join(bin, 'botwarren-companion'), ['pair', 'two words'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('companion|pair|two words|');
  });
});

describe.skipIf(process.platform === 'win32')('botwarren uninstall (macOS and Linux) and the launcher', () => {
  const UNINSTALL = join(import.meta.dirname, '..', '..', 'packaging', 'uninstall.sh');
  const run = (home: string) => spawnSync('sh', [UNINSTALL, '--yes'], { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' });
  const fakeHome = (shim: string) => {
    const home = mkTmp(); cleanup.push(() => rmTmp(home));
    const root = join(home, '.local', 'share', 'botwarren'); const bin = join(home, '.local', 'bin');
    mkdirSync(root, { recursive: true }); mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, 'current.json'), '{}'); writeFileSync(join(bin, 'botwarren'), '#!/bin/sh\n'); writeFileSync(join(bin, 'botwarren-companion'), shim);
    return { home, bin };
  };

  it('removes the launcher the agent wrote', () => {
    const h = fakeHome(shimText(false));
    expect(run(h.home).status).toBe(0);
    expect(existsSync(join(h.bin, 'botwarren'))).toBe(false);
    expect(existsSync(join(h.bin, 'botwarren-companion'))).toBe(false);
  });

  it('keeps a file of that name the agent did not write', () => {
    const h = fakeHome('#!/bin/sh\necho mine\n');
    expect(run(h.home).status).toBe(0);
    expect(existsSync(join(h.bin, 'botwarren'))).toBe(false);
    expect(readFileSync(join(h.bin, 'botwarren-companion'), 'utf8')).toContain('echo mine');
  });
});
