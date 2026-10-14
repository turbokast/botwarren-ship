/**
 * Launcher tests with REAL child processes: the "agent" of each version is a tiny script that exits, crashes, or stays up.
 * Timings are shrunk (poll 15 ms, confirm 120 ms, health timeout 500 ms).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock, pruneVersions, startLauncher, type LauncherOptions } from '../../src/launcher/launcher.ts';
import { EXIT_RESTART_FOR_UPDATE, paths, readDenylist, readPointer, readResult, writePointer, type Pointer } from '../../src/update/state.ts';
import { mkTmp, rmTmp } from './kit.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

const STAY = "setInterval(()=>{},1000); process.on('SIGTERM',()=>process.exit(0));";
const CRASH = 'process.exit(1);';
const restart = `process.exit(${EXIT_RESTART_FOR_UPDATE});`;

function mkInstall(versions: Record<string, string>, ptr: Pointer): string {
  const root = mkTmp(); cleanup.push(() => rmTmp(root));
  for (const [v, src] of Object.entries(versions)) { mkdirSync(join(root, 'versions', v), { recursive: true }); writeFileSync(join(root, 'versions', v, 'agent.mjs'), src); }
  writePointer(root, ptr);
  return root;
}
const trial = (version: string, previous: string | null, extra: Partial<Pointer> = {}): Pointer => ({ version, previous, knownGood: previous, state: 'trial', bootCount: 0, trialStarted: null, ...extra });
const stable = (version: string): Pointer => ({ version, previous: null, knownGood: version, state: 'stable', bootCount: 0, trialStarted: null });

const fast = (root: string, over: Partial<LauncherOptions> = {}): LauncherOptions => ({
  root, nodePath: process.execPath, configFile: null, pollMs: 15, confirmAfterMs: 120, healthTimeoutMs: 500, waitForConfigMs: 30, signals: false,
  health: async () => true, ...over,
});

const until = async (cond: () => boolean, ms = 6000): Promise<void> => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout waiting for condition'); await new Promise((r) => setTimeout(r, 20)); } };
const run = (o: LauncherOptions) => { const logs: string[] = []; const h = startLauncher({ ...o, log: (m) => logs.push(m) }); cleanup.push(() => h.stop()); return { ...h, logs }; };

describe('launcher: trial, health check, commit', () => {
  it('a healthy new version is confirmed after confirmAfterMs: stable, knownGood updated, older versions pruned, result recorded', async () => {
    const root = mkInstall({ '0.4.0': STAY, '0.5.0': STAY, '0.3.0': STAY }, { ...trial('0.5.0', '0.4.0'), knownGood: '0.4.0' });
    const l = run(fast(root));
    await until(() => readPointer(root)?.state === 'stable');
    expect(readPointer(root)).toMatchObject({ version: '0.5.0', state: 'stable', knownGood: '0.5.0', bootCount: 0 });
    expect(readResult(root)).toMatchObject({ code: 'confirmed', to: '0.5.0' });
    expect(existsSync(join(root, 'versions', '0.3.0'))).toBe(false); // pruned
    expect(existsSync(join(root, 'versions', '0.4.0'))).toBe(true);  // previous kept
    l.stop(); expect(await l.done).toBe(0);
  });

  it('ROLLBACK on repeated crashes in trial: previous version restored, bad one denylisted for 7 days, result recorded', async () => {
    const root = mkInstall({ '0.4.0': STAY, '0.5.0': CRASH }, trial('0.5.0', '0.4.0'));
    const l = run(fast(root, { maxTrialBoots: 5, health: async () => false, healthTimeoutMs: 20_000, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30))) })); // the crash limit (3 in the window) triggers first
    await until(() => readPointer(root)?.version === '0.4.0').catch((e) => { throw new Error(`${e.message}: ${l.logs.join(' | ')}`); });
    expect(readPointer(root)).toMatchObject({ version: '0.4.0', state: 'stable', previous: null });
    expect(readResult(root)).toMatchObject({ code: 'rolled_back_crash', from: '0.5.0', to: '0.4.0' });
    expect(readDenylist(root, Date.now())['0.5.0']).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    await until(() => l.logs.some((m) => m.includes('starting 0.4.0')));
    l.stop(); await l.done;
  }, 20_000);

  it('ROLLBACK on a failed health check: the process is alive but never healthy within the timeout', async () => {
    const root = mkInstall({ '0.4.0': STAY, '0.5.0': STAY }, trial('0.5.0', '0.4.0'));
    const l = run(fast(root, { health: async () => false }));
    await until(() => readPointer(root)?.version === '0.4.0');
    expect(readResult(root)).toMatchObject({ code: 'rolled_back_unhealthy', from: '0.5.0', to: '0.4.0' });
    expect(readDenylist(root, Date.now())['0.5.0']).toBeDefined();
    l.stop(); await l.done;
  });

  it('a version that flaps between healthy and unhealthy is not confirmed early (the healthy streak resets)', async () => {
    let n = 0;
    const root = mkInstall({ '0.4.0': STAY, '0.5.0': STAY }, trial('0.5.0', '0.4.0'));
    const l = run(fast(root, { confirmAfterMs: 300, healthTimeoutMs: 5000, health: async () => (++n % 5 !== 0) })); // unhealthy every 5th poll (~75 ms)
    await new Promise((r) => setTimeout(r, 600));
    expect(readPointer(root)).toMatchObject({ version: '0.5.0', state: 'trial' });
    l.stop(); await l.done;
  });

  it('the boot counter: a trial version that already booted maxTrialBoots times without confirming is rolled back BEFORE it starts again', async () => {
    const root = mkInstall({ '0.4.0': STAY, '0.5.0': STAY }, trial('0.5.0', '0.4.0', { bootCount: 2 }));
    const l = run(fast(root));
    await until(() => readPointer(root)?.version === '0.4.0');
    expect(l.logs.some((m) => m.includes('starting 0.5.0'))).toBe(false);
    expect(readResult(root)).toMatchObject({ code: 'rolled_back_crash' });
    l.stop(); await l.done;
  });

  it('each start of a trial version increments bootCount on disk', async () => {
    const root = mkInstall({ '0.4.0': STAY, '0.5.0': STAY }, trial('0.5.0', '0.4.0'));
    const l = run(fast(root, { confirmAfterMs: 60_000 }));
    await until(() => readPointer(root)?.bootCount === 1);
    l.stop(); await l.done;
  });

  it('with nothing to roll back to, it keeps running the version (and stops counting) instead of looping', async () => {
    const root = mkInstall({ '0.5.0': STAY }, { version: '0.5.0', previous: null, knownGood: null, state: 'trial', bootCount: 2, trialStarted: null });
    const l = run(fast(root));
    await until(() => l.logs.some((m) => m.includes('starting 0.5.0')));
    expect(readPointer(root)!.version).toBe('0.5.0');
    l.stop(); await l.done;
  });
});

describe('launcher: restarts, repair, config, lock', () => {
  it('exit code 75 means "restart into the (new) pointer": the update is picked up without a crash penalty', async () => {
    const root = mkInstall({ '0.4.0': `import {writeFileSync,readFileSync} from 'node:fs'; const p=${JSON.stringify(join('PLACEHOLDER', 'current.json'))}; process.exit(${EXIT_RESTART_FOR_UPDATE});`, '0.5.0': STAY }, stable('0.4.0'));
    // 0.4.0 stages 0.5.0 (as the real updater does) and exits 75
    writeFileSync(join(root, 'versions', '0.4.0', 'agent.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, 'current.json'))}, JSON.stringify({version:'0.5.0',previous:'0.4.0',knownGood:'0.4.0',state:'trial',bootCount:0,trialStarted:null})); ${restart}`);
    const l = run(fast(root, { confirmAfterMs: 60_000 }));
    await until(() => l.logs.some((m) => m.includes('starting 0.5.0')));
    expect(l.logs.some((m) => m.includes('restart'))).toBe(true);
    expect(l.logs.some((m) => m.includes('restarting in'))).toBe(false); // no crash backoff
    l.stop(); await l.done;
  });

  it('a stable version that crashes is restarted with backoff, never rolled back', async () => {
    const root = mkInstall({ '0.4.0': CRASH }, stable('0.4.0'));
    const l = run(fast(root, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30))) }));
    await until(() => l.logs.filter((m) => m.includes('starting 0.4.0')).length >= 3);
    expect(readPointer(root)).toMatchObject({ version: '0.4.0', state: 'stable' });
    expect(readResult(root)).toBeNull();
    l.stop(); await l.done;
  });

  it('repairs a pointer that names a missing version directory, using previous / knownGood', async () => {
    const root = mkInstall({ '0.4.0': STAY }, { version: '0.9.9', previous: '0.4.0', knownGood: '0.4.0', state: 'trial', bootCount: 0, trialStarted: null });
    const l = run(fast(root));
    await until(() => readPointer(root)?.version === '0.4.0');
    await until(() => l.logs.some((m) => m.includes('starting 0.4.0')));
    l.stop(); await l.done;
  });

  it('exits non-zero when no runnable version exists at all', async () => {
    const root = mkTmp(); cleanup.push(() => rmTmp(root));
    const l = run(fast(root));
    expect(await l.done).toBe(3);
  });

  it('does not start the agent until the config exists (not paired yet), then starts it', async () => {
    const root = mkInstall({ '0.4.0': STAY }, stable('0.4.0'));
    const cfg = join(root, 'config.json');
    const l = run(fast(root, { configFile: cfg }));
    await new Promise((r) => setTimeout(r, 150));
    expect(l.logs.some((m) => m.includes('starting'))).toBe(false);
    writeFileSync(cfg, '{}');
    await until(() => l.logs.some((m) => m.includes('starting 0.4.0')));
    l.stop(); await l.done;
  });

  it('stop() terminates the agent and resolves 0', async () => {
    const root = mkInstall({ '0.4.0': STAY }, stable('0.4.0'));
    const l = run(fast(root));
    await until(() => l.logs.some((m) => m.includes('starting')));
    l.stop();
    expect(await l.done).toBe(0);
  });

  it('single-instance lock: a second launcher yields while the first is alive; a stale lock is taken over', () => {
    const root = mkTmp(); cleanup.push(() => rmTmp(root));
    const rel = acquireLock(root, process.pid)!;
    expect(rel).toBeTypeOf('function');
    expect(acquireLock(root, process.pid + 1)).toBeNull(); // our own pid is alive -> held
    rel();
    writeFileSync(paths(root).lock, '999999999'); // a pid that cannot exist
    expect(acquireLock(root, process.pid + 1)).toBeTypeOf('function');
  });

  it('pruneVersions keeps only the named versions and ignores junk names', () => {
    const root = mkInstall({ '0.1.0': '', '0.2.0': '', '0.3.0': '' }, stable('0.3.0'));
    mkdirSync(join(root, 'versions', 'keepme'));
    expect(pruneVersions(root, ['0.3.0', null]).sort()).toEqual(['0.1.0', '0.2.0']);
    expect(existsSync(join(root, 'versions', 'keepme'))).toBe(true);
  });
});
