/**
 * The launcher: a small, rarely-changing supervisor that owns START, TRIAL, HEALTH CHECK and ROLLBACK.
 * It is bundled to launcher/launcher.mjs, DEPENDENCY-FREE (node built-ins + ../update/state.ts only) and is NOT replaced by
 * the silent updater, so a broken update can never break the thing that recovers from it.
 *
 * Version layout (see update/state.ts): versions/<v>/ are immutable, side by side; current.json is the pointer.
 *
 *   start  : pointer -> versions/<v>/agent.mjs run by the bundled node.
 *   trial  : a freshly staged version runs in state "trial". It must stay HEALTHY (the agent's loopback /healthz answers)
 *            for `confirmAfterMs`; then it becomes "stable" and older versions are pruned.
 *   rollback (automatic, no user action) when, in trial: the agent crashed `crashLimit` times within `crashWindowMs`, or it
 *            was started `maxTrialBoots` times without ever being confirmed, or it is not healthy `healthTimeoutMs` after
 *            start. The previous version is restored, the bad one is denylisted for 7 days, and a result code is recorded.
 *   update : the agent stages a version, rewrites the pointer and exits with EXIT_RESTART_FOR_UPDATE (75); the launcher
 *            restarts into the new pointer immediately.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import {
  EXIT_RESTART_FOR_UPDATE, denylistVersion, hasVersionDir, paths, readPointer, writePointer, writeResult,
  type Pointer, type ResultCode,
} from '../update/state.ts';

export interface LauncherOptions {
  root: string;
  nodePath: string;
  /** absolute path of the ship config; the agent is not started until it exists (the user may not have paired yet) */
  configFile: string | null;
  /** loopback health URL of the agent; default derived from the config's opsPort */
  healthUrl?: string;
  confirmAfterMs?: number;
  healthTimeoutMs?: number;
  crashWindowMs?: number;
  crashLimit?: number;
  maxTrialBoots?: number;
  pollMs?: number;
  waitForConfigMs?: number;
  denyMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnAgent?: (nodePath: string, entry: string, env: NodeJS.ProcessEnv) => ChildProcess;
  health?: () => Promise<boolean>;
  /** tests: resolved by `stop()` */
  signals?: boolean;
}

export interface LauncherHandle { done: Promise<number>; stop: () => void }

const DEFAULTS = { confirmAfterMs: 60_000, healthTimeoutMs: 120_000, crashWindowMs: 600_000, crashLimit: 3, maxTrialBoots: 2, pollMs: 1000, waitForConfigMs: 10_000, denyMs: 7 * 86_400_000 };

function opsPortFromConfig(configFile: string | null): number {
  try {
    const j = JSON.parse(readFileSync(configFile!, 'utf8').replace(/^﻿/, '')) as { opsPort?: unknown };
    return typeof j.opsPort === 'number' && j.opsPort >= 1024 && j.opsPort <= 65535 ? j.opsPort : 4411;
  } catch { return 4411; }
}

export function httpHealth(url: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') { resolve(false); return; }
      const req = request({ host: u.hostname === '[::1]' ? '::1' : u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: timeoutMs, agent: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    } catch { resolve(false); }
  });
}

/** Removes versions/<v> directories not in `keep`. Never touches the running (current) version. */
export function pruneVersions(root: string, keep: (string | null)[]): string[] {
  const removed: string[] = [];
  const keepSet = new Set(keep.filter((x): x is string => !!x));
  let names: string[] = [];
  try { names = readdirSync(paths(root).versions); } catch { return removed; }
  for (const n of names) {
    if (keepSet.has(n) || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(n)) continue;
    try { rmSync(paths(root).version(n), { recursive: true, force: true }); removed.push(n); } catch { /* AV lock etc.: retried next time */ }
  }
  return removed;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Single-instance lock. Returns a release function, or null when another launcher is alive. */
export function acquireLock(root: string, pid: number = process.pid): (() => void) | null {
  const file = paths(root).lock;
  mkdirSync(paths(root).state, { recursive: true, mode: 0o700 });
  try {
    const other = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(other) && other > 0 && other !== pid && processAlive(other)) return null;
  } catch { /* no lock */ }
  writeFileSync(file, String(pid), { mode: 0o600 });
  return () => { try { if (readFileSync(file, 'utf8').trim() === String(pid)) unlinkSync(file); } catch { /* ignore */ } };
}

export function startLauncher(opts: LauncherOptions): LauncherHandle {
  const o = { ...DEFAULTS, ...opts };
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  const health = opts.health ?? (() => httpHealth(o.healthUrl ?? `http://127.0.0.1:${opsPortFromConfig(o.configFile)}/healthz`));
  const doSpawn = opts.spawnAgent ?? ((node, entry, env) => spawn(node, ['--disable-warning=ExperimentalWarning', entry], { env, stdio: 'inherit', windowsHide: true }));
  let stopping = false;
  let child: ChildProcess | null = null;
  let wake: (() => void) | null = null;

  const rollback = (ptr: Pointer, code: ResultCode): boolean => {
    const target = ptr.previous && hasVersionDir(o.root, ptr.previous) ? ptr.previous : ptr.knownGood && ptr.knownGood !== ptr.version && hasVersionDir(o.root, ptr.knownGood) ? ptr.knownGood : null;
    if (!target) { log(`rollback impossible (${code}): no earlier version available`); return false; }
    denylistVersion(o.root, ptr.version, now() + o.denyMs, now());
    writePointer(o.root, { version: target, previous: null, knownGood: target, state: 'stable', bootCount: 0, trialStarted: null });
    writeResult(o.root, { code, from: ptr.version, to: target, atMs: now() });
    log(`rolled back ${ptr.version} -> ${target} (${code}); ${ptr.version} is skipped for 7 days`);
    return true;
  };

  const commit = (ptr: Pointer): void => {
    const next: Pointer = { ...ptr, state: 'stable', bootCount: 0, knownGood: ptr.version, trialStarted: null };
    writePointer(o.root, next);
    writeResult(o.root, { code: 'confirmed', from: ptr.previous ?? ptr.version, to: ptr.version, atMs: now() });
    const removed = pruneVersions(o.root, [next.version, next.previous, next.knownGood]);
    log(`version ${ptr.version} confirmed healthy${removed.length ? `; removed ${removed.join(', ')}` : ''}`);
  };

  const run = async (): Promise<number> => {
    const crashes: number[] = [];
    let backoff = 0;
    while (!stopping) {
      let ptr = readPointer(o.root);
      if (!ptr || !hasVersionDir(o.root, ptr.version)) {
        // pointer missing or pointing at a missing directory: fall back to the best remaining version
        const fallback = [ptr?.previous, ptr?.knownGood].find((v): v is string => !!v && hasVersionDir(o.root, v));
        if (fallback) { writePointer(o.root, { version: fallback, previous: null, knownGood: fallback, state: 'stable', bootCount: 0, trialStarted: null }); log(`pointer repaired -> ${fallback}`); continue; }
        log('no runnable version found'); return 3;
      }
      if (ptr.state === 'trial' && ptr.bootCount >= o.maxTrialBoots) {
        if (rollback(ptr, 'rolled_back_crash')) continue;
        writePointer(o.root, { ...ptr, state: 'stable', bootCount: 0 }); // nothing to go back to: stop counting, keep running
        continue;
      }
      if (o.configFile && !existsSync(o.configFile)) { // not paired yet: wait quietly, cheap
        await new Promise<void>((r) => { wake = r; void sleep(o.waitForConfigMs).then(r); });
        continue;
      }
      if (ptr.state === 'trial') { ptr = { ...ptr, bootCount: ptr.bootCount + 1, trialStarted: ptr.trialStarted ?? new Date(now()).toISOString() }; writePointer(o.root, ptr); }
      const entry = join(paths(o.root).version(ptr.version), 'agent.mjs');
      const startedAt = now();
      log(`starting ${ptr.version} (${ptr.state}${ptr.state === 'trial' ? `, boot ${ptr.bootCount}` : ''})`);
      child = doSpawn(o.nodePath, entry, { ...process.env, BOTWARREN_HOME: o.root });
      const exited = new Promise<number | null>((resolve) => { child!.once('exit', (code) => resolve(code)); child!.once('error', () => resolve(1)); });
      let exitCode: number | null | undefined;
      void exited.then((c) => { exitCode = c; wake?.(); });
      let healthySince: number | null = null;
      let committed = ptr.state !== 'trial';
      let unhealthyRollback = false;
      while (exitCode === undefined && !stopping) {
        await new Promise<void>((r) => { wake = r; void sleep(o.pollMs).then(r); });
        if (exitCode !== undefined || stopping) break;
        if (!committed) {
          if (await health()) { healthySince ??= now(); if (now() - healthySince >= o.confirmAfterMs) { commit(ptr); committed = true; } }
          else { healthySince = null; if (now() - startedAt >= o.healthTimeoutMs) { unhealthyRollback = true; child.kill('SIGKILL'); break; } }
        } else if (readPointer(o.root)?.version !== ptr.version && !stopping) {
          // pointer changed under us (manual update, rollback): the agent will exit by itself with 75 when idle
        }
      }
      if (stopping) {
        child.kill('SIGTERM');
        const t = setTimeout(() => child?.kill('SIGKILL'), 10_000); t.unref?.();
        await exited; clearTimeout(t);
        return 0;
      }
      if (unhealthyRollback) { await exited; const p = readPointer(o.root); if (p && rollback(p, 'rolled_back_unhealthy')) continue; }
      const code = (await exited) ?? 1;
      child = null;
      if (code === EXIT_RESTART_FOR_UPDATE) { log('agent asked for a restart (update)'); backoff = 0; continue; }
      const t = now();
      crashes.push(t);
      while (crashes.length && t - crashes[0]! > o.crashWindowMs) crashes.shift();
      const p = readPointer(o.root);
      if (p && p.state === 'trial' && crashes.length >= o.crashLimit) { if (rollback(p, 'rolled_back_crash')) { crashes.length = 0; continue; } }
      backoff = Math.min(30_000, backoff === 0 ? 1000 : backoff * 2);
      log(`agent exited (code ${code}); restarting in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
    return 0;
  };

  const stop = (): void => { stopping = true; wake?.(); };
  if (o.signals !== false) for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(s, stop);
  return { done: run(), stop };
}
