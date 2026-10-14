/**
 * Background update service inside the agent: schedules checks (>= 6 h apart + jitter, backoff on failure), and restarts
 * into a staged version only when the agent is idle (hard cap 24 h, 1 h for forced updates). Silent: no prompts.
 * It does nothing at all when policy.background is false (opt-out, managed install, no launcher).
 */
import { VERSION } from '../version.ts';
import { resolvePolicy, type Policy, type UpdatesConfig } from './policy.ts';
import { firstCheckAt } from './schedule.ts';
import { readPointer, readUpdateState } from './state.ts';
import { Updater } from './updater.ts';

export interface UpdateServiceOptions {
  env: Record<string, string | undefined>;
  config: UpdatesConfig | undefined;
  log: (m: string) => void;
  /** no recent session activity */
  isIdle: () => boolean;
  /** drain and exit with EXIT_RESTART_FOR_UPDATE so the launcher starts the new version */
  restart: () => void;
  now?: () => number;
  /** polling period for the pointer watcher (tests shrink it) */
  watchMs?: number;
  updater?: Updater;
  rand?: () => number;
}

export interface UpdateServiceHandle { policy: Policy; stop: () => void }

export function startUpdateService(o: UpdateServiceOptions): UpdateServiceHandle {
  const root = o.env.BOTWARREN_HOME || null;
  const policy = resolvePolicy({ env: o.env, config: o.config, root, execPath: process.execPath });
  const now = o.now ?? Date.now;
  const timers: NodeJS.Timeout[] = [];
  const stop = (): void => { for (const t of timers) clearTimeout(t); timers.length = 0; };
  if (!root) return { policy, stop };

  // Restart watcher: a staged version (by this service or by `botwarren update`) is started when idle.
  let pendingSince: number | null = null;
  const watch = (): void => {
    const ptr = readPointer(root);
    if (ptr && ptr.version !== VERSION) {
      pendingSince ??= now();
      const cap = now() - pendingSince >= 24 * 3_600_000;
      if (o.isIdle() || cap) { o.log(`update: restarting into ${ptr.version}${cap ? ' (idle window never came, hard cap)' : ''}`); o.restart(); return; }
    } else pendingSince = null;
    const t = setTimeout(watch, o.watchMs ?? 30_000); t.unref(); timers.push(t);
  };
  if (policy.background || policy.manual) { const t = setTimeout(watch, o.watchMs ?? 30_000); t.unref(); timers.push(t); }
  if (!policy.background) return { policy, stop };

  const updater = o.updater ?? new Updater({
    root, baseUrl: policy.baseUrl, currentVersion: VERSION, channel: policy.channel, platform: policy.platform!, maximumVersion: policy.maximumVersion,
    allowDevKey: o.env.BOTWARREN_UPDATE_ALLOW_DEV_KEY === '1', log: o.log, ...(o.rand ? { rand: o.rand } : {}),
  });
  const schedule = (atMs: number): void => {
    const t = setTimeout(() => { void run(); }, Math.max(0, atMs - now())); t.unref(); timers.push(t);
  };
  const run = async (): Promise<void> => {
    try { await updater.check(); } catch { /* never throws into the agent; the failure is recorded by the updater */ }
    schedule(readUpdateState(root).nextCheckMs || now() + 6 * 3_600_000);
  };
  const st = readUpdateState(root);
  schedule(firstCheckAt(now(), st.nextCheckMs, o.rand));
  return { policy, stop };
}
