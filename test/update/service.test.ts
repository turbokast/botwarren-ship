import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startUpdateService } from '../../src/update/service.ts';
import { runUpdate, runVerifyRelease } from '../../src/update/cli.ts';
import { writePointer } from '../../src/update/state.ts';
import { VERSION } from '../../src/version.ts';
import type { Updater } from '../../src/update/updater.ts';
import { NOW, makeKey, makeManifest, makeRoot, mkTmp, rmTmp, sign, sha256 } from './kit.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('update service', () => {
  it('is inert without a launcher-managed install (dev / tests): no timers, nothing to restart', () => {
    let calls = 0;
    const h = startUpdateService({ env: {}, config: undefined, log: () => {}, isIdle: () => true, restart: () => { calls++; } });
    expect(h.policy).toMatchObject({ background: false, reason: 'no_install_root' });
    h.stop(); expect(calls).toBe(0);
  });

  it('checks in the background after the startup jitter, then reschedules from the persisted next-check time', async () => {
    const root = makeRoot(VERSION); cleanup.push(() => rmTmp(root));
    let checks = 0;
    const fake = { check: async () => { checks++; return { status: 'up_to_date' as const, version: VERSION }; } } as unknown as Updater;
    const h = startUpdateService({ env: { BOTWARREN_HOME: root, BOTWARREN_INSTALL_METHOD: 'standalone' }, config: undefined, log: () => {}, isIdle: () => true, restart: () => {}, updater: fake, rand: () => 0, watchMs: 10_000 });
    cleanup.push(h.stop);
    expect(h.policy.background).toBe(true);
    await wait(60);
    expect(checks).toBe(1); // exactly one; the next is scheduled hours out
  });

  it('opt-out: with BOTWARREN_DISABLE_AUTOUPDATE no background check ever runs', async () => {
    const root = makeRoot(VERSION); cleanup.push(() => rmTmp(root));
    let checks = 0;
    const fake = { check: async () => { checks++; return { status: 'up_to_date' as const, version: VERSION }; } } as unknown as Updater;
    const h = startUpdateService({ env: { BOTWARREN_HOME: root, BOTWARREN_DISABLE_AUTOUPDATE: '1' }, config: undefined, log: () => {}, isIdle: () => true, restart: () => {}, updater: fake, rand: () => 0 });
    cleanup.push(h.stop);
    await wait(60);
    expect(checks).toBe(0);
  });

  it('restarts into a staged version only when idle (and at the hard cap otherwise)', async () => {
    const root = makeRoot(VERSION); cleanup.push(() => rmTmp(root));
    writePointer(root, { version: '9.9.9', previous: VERSION, knownGood: VERSION, state: 'trial', bootCount: 0, trialStarted: null });
    let idle = false; let restarts = 0; let clock = NOW.getTime();
    const h = startUpdateService({ env: { BOTWARREN_HOME: root, BOTWARREN_DISABLE_AUTOUPDATE: '1' }, config: undefined, log: () => {}, isIdle: () => idle, restart: () => { restarts++; }, watchMs: 15, now: () => clock });
    cleanup.push(h.stop);
    await wait(80);
    expect(restarts).toBe(0); // busy: no restart
    idle = true;
    await wait(80);
    expect(restarts).toBe(1);
    h.stop();
    // hard cap: busy forever, but 24 h pass
    restarts = 0; idle = false;
    const h2 = startUpdateService({ env: { BOTWARREN_HOME: root, BOTWARREN_DISABLE_AUTOUPDATE: '1' }, config: undefined, log: () => {}, isIdle: () => idle, restart: () => { restarts++; }, watchMs: 15, now: () => clock });
    cleanup.push(h2.stop);
    await wait(50); expect(restarts).toBe(0);
    clock += 25 * 3_600_000;
    await wait(50); expect(restarts).toBe(1);
  });

  it('a managed install (brew) never watches or updates', async () => {
    const root = makeRoot(VERSION); cleanup.push(() => rmTmp(root));
    writePointer(root, { version: '9.9.9', previous: VERSION, knownGood: VERSION, state: 'trial', bootCount: 0, trialStarted: null });
    let restarts = 0;
    const h = startUpdateService({ env: { BOTWARREN_HOME: root, BOTWARREN_INSTALL_METHOD: 'brew' }, config: undefined, log: () => {}, isIdle: () => true, restart: () => { restarts++; }, watchMs: 10 });
    cleanup.push(h.stop);
    await wait(60);
    expect(restarts).toBe(0);
  });
});

describe('botwarren update / verify-release', () => {
  const run = async (fn: (d: { out: (s: string) => void; err: (s: string) => void }) => Promise<number>) => { let out = ''; let err = ''; const code = await fn({ out: (s) => { out += s; }, err: (s) => { err += s; } }); return { code, out, err }; };

  it('update status explains the policy and the opt-outs', async () => {
    const root = makeRoot('0.4.0'); cleanup.push(() => rmTmp(root));
    const r = await run((d) => runUpdate(['status'], { ...d, env: { BOTWARREN_HOME: root } }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('Automatic updates: on (stable channel, from https://downloads.botwarren.com)');
    expect(r.out).toContain('BOTWARREN_DISABLE_AUTOUPDATE');
  });

  it('a package-manager install tells the user to use the package manager and does not touch the network', async () => {
    let called = false;
    const fake = { check: async () => { called = true; return { status: 'up_to_date' as const, version: '0' }; } } as unknown as Updater;
    const r = await run((d) => runUpdate([], { ...d, env: { BOTWARREN_HOME: '/x', BOTWARREN_INSTALL_METHOD: 'brew' }, updater: fake }));
    expect(r.out).toContain('installed with brew');
    expect(called).toBe(false);
  });

  it('manual update honours --dry-run and reports the outcome; DISABLE_UPDATES blocks it entirely', async () => {
    let args: unknown;
    const fake = { check: async (a: unknown) => { args = a; return { status: 'would_update' as const, version: '0.5.0', forced: false, rollback: false }; } } as unknown as Updater;
    const root = makeRoot('0.4.0'); cleanup.push(() => rmTmp(root));
    const r = await run((d) => runUpdate(['--dry-run'], { ...d, env: { BOTWARREN_HOME: root }, updater: fake }));
    expect(r.out).toContain('Would update to 0.5.0');
    expect(args).toMatchObject({ dryRun: true });
    const blocked = await run((d) => runUpdate([], { ...d, env: { BOTWARREN_HOME: root, BOTWARREN_DISABLE_UPDATES: '1' }, updater: fake }));
    expect(blocked.code).toBe(1);
  });

  it('verify-release: accepts the signed manifest and the matching archive hash; refuses a tampered manifest, a wrong hash, or an untrusted key', async () => {
    const key = makeKey('rel-1');
    const d = mkTmp(); cleanup.push(() => rmTmp(d));
    const { manifest } = makeManifest({ stable: '0.5.0', releases: [{ version: '0.5.0' }] });
    const archiveSha = sha256(Buffer.from('archive'));
    manifest.releases['0.5.0']!.full['linux-x64'] = { url: 'x.tar.gz', sha256: archiveSha, size: 7 };
    const s = sign(manifest, key);
    const mf = join(d, 'manifest.json'); const sf = join(d, 'manifest.json.sig');
    writeFileSync(mf, s.bytes); writeFileSync(sf, s.sig);
    const base = ['--manifest', mf, '--sig', sf];
    const keys = [key.pinned];
    expect((await run((x) => runVerifyRelease([...base, '--archive-sha256', archiveSha, '--platform', 'linux-x64'], { ...x, keys }))).code).toBe(0);
    expect((await run((x) => runVerifyRelease([...base, '--archive-sha256', sha256(Buffer.from('other')), '--platform', 'linux-x64'], { ...x, keys }))).code).toBe(1);
    expect((await run((x) => runVerifyRelease([...base, '--archive-sha256', archiveSha, '--platform', 'mac-arm64'], { ...x, keys }))).code).toBe(1);
    expect((await run((x) => runVerifyRelease(base, { ...x, keys: [makeKey('rel-1').pinned] }))).code).toBe(1); // same id, different key
    writeFileSync(mf, Buffer.concat([s.bytes, Buffer.from(' ')]));
    const bad = await run((x) => runVerifyRelease(base, { ...x, keys }));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('FAILED');
    expect((await run((x) => runVerifyRelease([], x))).code).toBe(2);
  });
});
